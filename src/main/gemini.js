'use strict';

// Gemini client (raw REST from the main process — no SDK dependency).
//
// • transcribeFile        — single WAV → verbatim transcript
// • transcribeConversation — two WAVs (mic + system audio) → speaker-labeled transcript
// • generateTitle         — transcript → short summary title
// • embedText             — text → embedding vector (semantic search)
//
// Audio under ~15 MB goes inline (base64); larger goes via the Files API.

const fsp = require('fs/promises');

const HOST = 'https://generativelanguage.googleapis.com';
const INLINE_MAX_BYTES = 15 * 1024 * 1024;
const PAIR_INLINE_MAX = 18 * 1024 * 1024; // combined cap for two inline tracks
const MIME = 'audio/wav';
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIM = 768;

const TRANSCRIBE_PROMPT =
  'Transcribe the speech in this audio verbatim, word for word, in the original ' +
  'spoken language (detect it automatically — it may be Turkish or English — and do ' +
  'NOT translate). Preserve natural sentence punctuation. Output ONLY the transcript ' +
  'text: no preamble, no commentary, no quotation marks, no timestamps, and no ' +
  'speaker labels. If there is no intelligible speech, output an empty response.';

function conversationPrompt(micName, sysName) {
  return (
    `You are given two audio tracks recorded at the same time.\n` +
    `TRACK A (the first audio) is "${micName}" speaking into the microphone.\n` +
    `TRACK B (the second audio) is the computer's audio output — the other participant(s), labeled "${sysName}".\n` +
    `Produce ONE merged, chronological transcript of the SPOKEN WORDS only. Put each ` +
    `utterance on its own line, prefixed with the speaker's name and a colon, e.g. ` +
    `"${micName}: ...". Use exactly "${micName}:" for words from TRACK A and "${sysName}:" ` +
    `for words from TRACK B. Each line MUST start with exactly ONE of those two names — ` +
    `never put both names on the same line, and never nest one label inside another.\n` +
    `IMPORTANT: Transcribe only actual speech. Ignore music, songs, ringtones, background ` +
    `noise, and silence. NEVER output a speaker label with no words after it. If a track has ` +
    `no speech, include no lines for it. If there is no speech in either track, output nothing.\n` +
    `Detect the spoken language automatically and do NOT translate. Output ONLY transcript lines.`
  );
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Put every speaker turn on its own line: the model often runs several turns
// together as "A: ... B: ... A: ..." on one line. Break before each in-line
// label (only the known speaker names, so real colons in speech are left alone).
function splitInlineLabels(text, names) {
  if (names.length === 0) return text;
  const inline = new RegExp('[ \\t]+((?:' + names.map(escRe).join('|') + '):)', 'g');
  return (text || '')
    .split('\n')
    .map((line) => line.replace(inline, '\n$1'))
    .join('\n');
}

// Defuse model repetition loops (e.g. a "Deneme. Deneme." mic-test segment that
// gets echoed thousands of times). Only kicks in on a block that is genuinely
// degenerate — few distinct lines repeated many times — so real conversation,
// which is highly varied, is left untouched.
function collapseRepeats(lines) {
  if (lines.length < 12) return lines;
  const distinct = new Set(lines).size;
  if (distinct / lines.length > 0.5) return lines; // varied → not a loop
  const seen = new Map();
  const out = [];
  for (const l of lines) {
    const n = (seen.get(l) || 0) + 1;
    seen.set(l, n);
    if (n <= 2) out.push(l); // keep first couple, drop the runaway echoes
  }
  return out;
}

// Clean up the labeled transcript: split run-together turns onto their own
// lines, drop bare "Speaker:" lines (music/silence), collapse any
// "Me: System Sound: ..." double-prefix, and defuse repetition loops.
function cleanLabeledTranscript(text, micName, sysName) {
  const names = [micName, sysName].filter(Boolean).map((n) => n.trim());
  const dedup =
    names.length === 2
      ? new RegExp('^(?:' + names.map(escRe).join('|') + '):\\s*((?:' + names.map(escRe).join('|') + '):\\s*)', 'i')
      : null;
  const leadNorm =
    names.length > 0 ? new RegExp('^((?:' + names.map(escRe).join('|') + ')):[ \\t]+') : null;
  const cleaned = splitInlineLabels(text || '', names)
    .split('\n')
    .map((l) => {
      l = l.replace(/\s+$/, '');
      if (dedup) l = l.replace(dedup, '$1'); // drop the redundant leading label
      if (leadNorm) l = l.replace(leadNorm, '$1: '); // one space after the label
      return l;
    })
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^.{1,40}:\s*$/.test(t)) return false; // a label with nothing after the colon
      return true;
    });
  return collapseRepeats(cleaned).join('\n').trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function describeHttpError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  return `Gemini API ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`;
}

// Pull the candidate's text plus finishReason so callers that parse structured
// output can tell a clean stop from a MAX_TOKENS truncation.
function extractCandidate(data) {
  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Audio was blocked by safety filters (${data.promptFeedback.blockReason}).`);
  }
  const cand = data?.candidates?.[0];
  if (!cand) throw new Error('Gemini returned no candidates.');
  const parts = cand.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return { text, finishReason: cand.finishReason || 'STOP' };
}

function extractText(data) {
  const { text, finishReason } = extractCandidate(data);
  if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS' && !text) {
    throw new Error(`Generation stopped early (${finishReason}).`);
  }
  return text;
}

function generateUrl(model) {
  return `${HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

// Pro models run in mandatory "thinking" mode and reject thinkingBudget:0; Flash
// and Flash-Lite models let us turn thinking off for faster, cheaper output
// (transcription doesn't benefit from reasoning). Detect which family a model is.
function thinksByDefault(model) {
  return /pro/i.test(model || '');
}

// Build a generationConfig that disables thinking where allowed. `extra` overrides
// (e.g. temperature, maxOutputTokens) are merged on top.
function genConfig(model, extra) {
  const cfg = { temperature: 0, ...(extra || {}) };
  if (!thinksByDefault(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
  return cfg;
}

async function callGenerateFull({ apiKey, model, parts, generationConfig, signal }) {
  const res = await fetch(generateUrl(model), {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: generationConfig || genConfig(model),
    }),
    signal,
  });
  if (!res.ok) throw new Error(await describeHttpError(res));
  return extractCandidate(await res.json());
}

async function callGenerate(opts) {
  const { text, finishReason } = await callGenerateFull(opts);
  if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS' && !text) {
    throw new Error(`Generation stopped early (${finishReason}).`);
  }
  return text;
}

// --- Files API ------------------------------------------------------------

async function uploadFile({ apiKey, buffer, signal }) {
  const start = await fetch(`${HOST}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': MIME,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'recording.wav' } }),
    signal,
  });
  if (!start.ok) throw new Error(await describeHttpError(start));
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini Files API did not return an upload URL.');

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
    signal,
  });
  if (!up.ok) throw new Error(await describeHttpError(up));
  const file = (await up.json())?.file;
  if (!file?.uri || !file?.name) throw new Error('Gemini Files API returned no file reference.');
  return file;
}

async function waitUntilActive({ apiKey, file, signal, timeoutMs = 60000 }) {
  let state = file.state;
  const id = file.name.replace(/^files\//, '');
  const deadline = Date.now() + timeoutMs;
  while (state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Gemini to process the audio.');
    await sleep(1200);
    const res = await fetch(`${HOST}/v1beta/files/${id}`, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!res.ok) throw new Error(await describeHttpError(res));
    state = (await res.json())?.state;
    if (state === 'FAILED') throw new Error('Gemini failed to process the uploaded audio.');
  }
  return state;
}

function inlinePart(buffer) {
  return { inline_data: { mime_type: MIME, data: buffer.toString('base64') } };
}

async function filePart({ apiKey, buffer, signal }) {
  const file = await uploadFile({ apiKey, buffer, signal });
  if (file.state === 'PROCESSING') await waitUntilActive({ apiKey, file, signal });
  return { file_data: { mime_type: MIME, file_uri: file.uri } };
}

// --- public: transcription ------------------------------------------------

async function transcribeFile({ apiKey, model, filePath, signal }) {
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const buffer = await fsp.readFile(filePath);
  const part = buffer.length <= INLINE_MAX_BYTES ? inlinePart(buffer) : await filePart({ apiKey, buffer, signal });
  return callGenerate({ apiKey, model, parts: [{ text: TRANSCRIBE_PROMPT }, part], signal });
}

// A few minutes of two-speaker speech is at most ~1500 tokens; cap well above
// that so a repetition loop on a low-content window can't run away to tens of
// thousands of tokens (collapseRepeats then cleans up whatever slips through).
// Thinking (Pro) models also spend output tokens reasoning, so give them more room.
const TRANSCRIBE_MAX_TOKENS = 4096;

// Audio buffer → request part, inline when small enough, Files API otherwise.
async function audioPart({ apiKey, buffer, signal }) {
  return buffer.length <= INLINE_MAX_BYTES ? inlinePart(buffer) : await filePart({ apiKey, buffer, signal });
}

async function pairParts({ apiKey, micBuffer, sysBuffer, signal }) {
  const inline = micBuffer.length + sysBuffer.length <= PAIR_INLINE_MAX;
  const micPart = inline ? inlinePart(micBuffer) : await filePart({ apiKey, buffer: micBuffer, signal });
  const sysPart = inline ? inlinePart(sysBuffer) : await filePart({ apiKey, buffer: sysBuffer, signal });
  return [micPart, sysPart];
}

// Transcribe one mic+system window into speaker-labeled lines (internal helper).
async function transcribePair({ apiKey, model, micBuffer, sysBuffer, prompt, signal }) {
  const [micPart, sysPart] = await pairParts({ apiKey, micBuffer, sysBuffer, signal });
  const maxOutputTokens = thinksByDefault(model) ? TRANSCRIBE_MAX_TOKENS * 2 : TRANSCRIBE_MAX_TOKENS;
  return callGenerate({
    apiKey,
    model,
    parts: [{ text: prompt }, micPart, sysPart],
    generationConfig: genConfig(model, { maxOutputTokens }),
    signal,
  });
}

// Two simultaneous tracks (mic + system audio buffers) → speaker-labeled transcript.
async function transcribeConversation({ apiKey, model, micBuffer, sysBuffer, micName, sysName, signal }) {
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const prompt = conversationPrompt(micName || 'Me', sysName || 'System Sound');
  const out = await transcribePair({ apiKey, model, micBuffer, sysBuffer, prompt, signal });
  return cleanLabeledTranscript(out, micName || 'Me', sysName || 'System Sound');
}

// Long recordings: transcribe each time window separately, then concatenate in
// order. One-shot transcription of many-minute audio degrades into an unbroken
// wall of text (the model gives up on per-utterance segmentation), so we feed it
// short, independently-segmentable windows produced by wav.chunkStereo.
async function transcribeConversationChunked({ apiKey, model, chunks, micName, sysName, signal, onProgress }) {
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const mn = micName || 'Me';
  const sn = sysName || 'System Sound';
  const prompt = conversationPrompt(mn, sn);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('Transcription cancelled.');
    const c = chunks[i];
    const out = await transcribePair({ apiKey, model, micBuffer: c.left, sysBuffer: c.right, prompt, signal });
    const cleaned = cleanLabeledTranscript(out, mn, sn);
    if (cleaned) parts.push(cleaned);
    if (onProgress) onProgress(i + 1, chunks.length);
  }
  return parts.join('\n');
}

// --- public: diarization ----------------------------------------------------
//
// Structured transcription: instead of free-text "Name: line" output, the model
// returns JSON segments referencing a speaker roster, so several voices on one
// track each get their own label ("Man 1", "Woman 1", "Speaker 2"…). Long
// recordings are transcribed window-by-window with the roster + a short
// conversation tail threaded through, so labels stay stable across windows.
// The CODE — never the model — owns display-label allocation: an unrecognized
// model label always maps to a fresh roster entry named from the gender enum.

const DIARIZE_MAX_TOKENS = 8192; // JSON output runs ~2.5-3× plain text

const DIARIZE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING' },
    speakers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          gender: { type: 'STRING', enum: ['male', 'female', 'unknown'] },
          track: { type: 'STRING', enum: ['A', 'B'] },
          voice: { type: 'STRING' },
        },
        required: ['label', 'gender'],
        propertyOrdering: ['label', 'gender', 'track', 'voice'],
      },
    },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          speaker: { type: 'STRING' },
          start: { type: 'NUMBER' },
          end: { type: 'NUMBER' },
          text: { type: 'STRING' },
        },
        required: ['speaker', 'text'],
        propertyOrdering: ['speaker', 'start', 'end', 'text'],
      },
    },
  },
  required: ['speakers', 'segments'],
  propertyOrdering: ['language', 'speakers', 'segments'],
};

// Display labels come from the gender enum via these words; the model's own
// label text is only ever used to MATCH speakers, never shown to the user.
const GENDER_WORD = { male: 'Man', female: 'Woman', unknown: 'Speaker' };

function rosterBlock(roster, tail) {
  if (!roster.length) return '';
  const known = roster.map(({ label, gender, voice }) => ({ label, gender, voice: voice || undefined }));
  let block =
    `KNOWN SPEAKERS from earlier parts of this same recording — reuse these exact ` +
    `labels for the same voices:\n${JSON.stringify(known)}\n`;
  if (tail && tail.length) block += `The conversation so far ended with:\n${tail.join('\n')}\n`;
  return block;
}

function diarizeRules() {
  return (
    `Labeling rules:\n` +
    `- Reuse a KNOWN SPEAKER's exact label when the voice matches; never renumber or rename a known speaker.\n` +
    `- Every other distinct voice gets a NEW label: "Man N" for a male voice, "Woman N" for a female ` +
    `voice, "Speaker N" if unsure — continue numbering after the known speakers.\n` +
    `- Labels keep this exact English form even when the speech is Turkish.\n` +
    `Transcription rules: transcribe the SPOKEN WORDS verbatim in the original language (it may be ` +
    `Turkish or English — do NOT translate), with natural punctuation, as one chronological list of ` +
    `segments; start a new segment whenever the speaker changes. Ignore music, songs, ringtones, ` +
    `background noise, and silence. Never emit a segment with empty text. If there is no speech at ` +
    `all, return {"speakers":[],"segments":[]}.\n` +
    `For each segment set "start" and "end" in seconds from the beginning of THIS audio (best ` +
    `effort). In "speakers", list every label you used with its gender, the track it was heard on, ` +
    `and a short "voice" description (pitch, pace, accent, apparent age) that would help recognize ` +
    `the voice later. Set "language" to the dominant spoken language as a two-letter code.`
  );
}

function diarizeStereoPrompt({ micName, sysName, roster, tail }) {
  return (
    `You are given two audio tracks recorded at the same time.\n` +
    `TRACK A (the first audio) is the microphone of "${micName}". Normally the only voice on ` +
    `TRACK A is ${micName} — label their words exactly "${micName}". If a clearly different ` +
    `person also speaks on TRACK A, give them their own label.\n` +
    `TRACK B (the second audio) is the computer's audio output ("${sysName}") — the other side ` +
    `of the call. It may contain ONE OR SEVERAL different people: listen to the voices and keep ` +
    `each distinct voice as its own speaker.\n` +
    rosterBlock(roster, tail) +
    diarizeRules()
  );
}

function diarizeMonoPrompt({ userName, roster, tail }) {
  return (
    `You are given one audio track recorded on ${userName}'s device. It may be a solo voice ` +
    `note or an in-room conversation between several people.\n` +
    `If exactly ONE person speaks in this audio, label them exactly "${userName}". If SEVERAL ` +
    `people speak, keep each distinct voice as its own speaker and do not assume which of them ` +
    `is ${userName}.\n` +
    rosterBlock(roster, tail) +
    diarizeRules()
  );
}

// Validate + normalize a parsed diarization payload; null if unusable.
function validateDiarization(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.speakers) || !Array.isArray(obj.segments)) return null;
  const speakers = [];
  for (const s of obj.speakers) {
    if (!s || typeof s.label !== 'string' || !s.label.trim()) continue;
    speakers.push({
      label: s.label.trim(),
      gender: s.gender === 'male' || s.gender === 'female' ? s.gender : 'unknown',
      track: s.track === 'A' || s.track === 'B' ? s.track : undefined,
      voice: typeof s.voice === 'string' ? s.voice.trim().slice(0, 160) : '',
    });
  }
  const segments = [];
  for (const g of obj.segments) {
    if (!g || typeof g.speaker !== 'string' || typeof g.text !== 'string') continue;
    const text = g.text.trim();
    if (!text || !g.speaker.trim()) continue;
    segments.push({
      speaker: g.speaker.trim(),
      text,
      start: Number.isFinite(g.start) ? g.start : undefined,
      end: Number.isFinite(g.end) ? g.end : undefined,
    });
  }
  return {
    language: typeof obj.language === 'string' ? obj.language.trim().toLowerCase().slice(0, 8) : '',
    speakers,
    segments,
  };
}

// A MAX_TOKENS response cuts off mid-array. Walk back to the last complete
// object and re-close the JSON so the segments that did complete survive.
function salvageTruncatedJson(text) {
  const t = (text || '').trim();
  for (let i = t.length; i > 1; i--) {
    if (t[i - 1] !== '}') continue;
    const head = t.slice(0, i);
    for (const close of [']}', '],"segments":[]}']) {
      try {
        return JSON.parse(head + close);
      } catch {
        /* keep walking back */
      }
    }
  }
  return null;
}

function parseDiarization(text) {
  try {
    return validateDiarization(JSON.parse(text));
  } catch {
    return validateDiarization(salvageTruncatedJson(text));
  }
}

// One structured call for one time window, with a repair ladder: parse →
// salvage a truncated response → one retry with a little thinking room.
async function diarizeChunk({ apiKey, model, promptText, audioParts, signal }) {
  const base = {
    maxOutputTokens: thinksByDefault(model) ? DIARIZE_MAX_TOKENS * 2 : DIARIZE_MAX_TOKENS,
    responseMimeType: 'application/json',
    responseSchema: DIARIZE_SCHEMA,
  };
  const parts = [{ text: promptText }, ...audioParts];
  let out = await callGenerateFull({ apiKey, model, parts, generationConfig: genConfig(model, base), signal });
  let parsed = parseDiarization(out.text);
  if (parsed) return parsed;
  const retryCfg = genConfig(model, base);
  if (!thinksByDefault(model)) retryCfg.thinkingConfig = { thinkingBudget: 1024 };
  out = await callGenerateFull({ apiKey, model, parts, generationConfig: retryCfg, signal });
  parsed = parseDiarization(out.text);
  if (parsed) return parsed;
  throw new Error('Diarization returned unusable JSON.');
}

// collapseRepeats for structured segments (key = speaker + text).
function collapseRepeatSegments(segs) {
  if (segs.length < 12) return segs;
  const keys = segs.map((g) => `${g.speaker}\n${g.text}`);
  if (new Set(keys).size / segs.length > 0.5) return segs; // varied → not a loop
  const seen = new Map();
  return segs.filter((g, i) => {
    const n = (seen.get(keys[i]) || 0) + 1;
    seen.set(keys[i], n);
    return n <= 2;
  });
}

// Flatten structured segments to the classic "Label: text" lines — the format
// stored in the .txt file and manifest, which search/copy/export consume.
function flattenSegments(speakers, segments) {
  const labels = new Map(speakers.map((s) => [s.id, s.label]));
  return segments
    .map((g) => `${labels.get(g.speaker) || 'Speaker'}: ${g.text}`)
    .join('\n')
    .trim();
}

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round1 = (v) => Math.round(v * 10) / 10;

// Diarized transcription over pre-cut time windows (from wav.chunkStereo /
// wav.chunkMono; a short recording is simply one window). mode: 'stereo' uses
// {left, right} buffers per chunk, 'mono' uses {mono}.
// Returns { language, speakers, segments, text }.
async function diarizeChunked({ apiKey, model, mode, chunks, micName, sysName, signal, onProgress }) {
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const userLabel = (micName || 'Me').trim();
  const sysLabel = (sysName || 'System Sound').trim();

  const roster = []; // { id, label, gender, source, voice, isUser }
  const counters = { male: 1, female: 1, unknown: 1 };
  const segments = []; // { speaker: roster id, text, start?, end? }
  let language = '';
  let okWindows = 0;

  function addSpeaker({ label, gender, source, voice, isUser }) {
    const sp = {
      id: `S${roster.length + 1}`,
      label,
      gender: gender || 'unknown',
      source,
      voice: voice || '',
      isUser: !!isUser,
    };
    roster.push(sp);
    return sp;
  }

  function allocSpeaker(gender, source, voice) {
    const g = gender === 'male' || gender === 'female' ? gender : 'unknown';
    return addSpeaker({ label: `${GENDER_WORD[g]} ${counters[g]++}`, gender: g, source, voice });
  }

  function findOrAddUser(source) {
    return roster.find((s) => s.isUser) || addSpeaker({ label: userLabel, source, isUser: true });
  }

  function tailLines() {
    const labels = new Map(roster.map((s) => [s.id, s.label]));
    return segments.slice(-6).map((g) => `${labels.get(g.speaker)}: ${g.text}`);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('Transcription cancelled.');
    const c = chunks[i];
    const chunkDur = Math.max(0, (c.endSec || 0) - (c.startSec || 0));

    let parsed = null;
    try {
      const promptText =
        mode === 'stereo'
          ? diarizeStereoPrompt({ micName: userLabel, sysName: sysLabel, roster, tail: tailLines() })
          : diarizeMonoPrompt({ userName: userLabel, roster, tail: tailLines() });
      const audioParts =
        mode === 'stereo'
          ? await pairParts({ apiKey, micBuffer: c.left, sysBuffer: c.right, signal })
          : [await audioPart({ apiKey, buffer: c.mono, signal })];
      parsed = await diarizeChunk({ apiKey, model, promptText, audioParts, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[diarize] window ${i + 1}/${chunks.length} fell back to plain transcription:`, err.message);
      // Plain-text fallback for just this window: two channel labels (stereo)
      // or an unattributed block credited to the user (mono).
      try {
        if (mode === 'stereo') {
          const out = await transcribePair({
            apiKey, model, micBuffer: c.left, sysBuffer: c.right,
            prompt: conversationPrompt(userLabel, sysLabel), signal,
          });
          for (const line of cleanLabeledTranscript(out, userLabel, sysLabel).split('\n')) {
            const mLine = /^(.{1,40}?):\s+(.*)$/.exec(line);
            const label = mLine ? mLine[1].trim() : '';
            const text = (mLine ? mLine[2] : line).trim();
            if (!text) continue;
            const sp =
              label.toLowerCase() === userLabel.toLowerCase()
                ? findOrAddUser('mic')
                : roster.find((s) => s.label === sysLabel) || addSpeaker({ label: sysLabel, source: 'sys' });
            segments.push({ speaker: sp.id, text });
          }
        } else {
          const part = await audioPart({ apiKey, buffer: c.mono, signal });
          const text = await callGenerate({
            apiKey, model, parts: [{ text: TRANSCRIBE_PROMPT }, part],
            generationConfig: genConfig(model, { maxOutputTokens: TRANSCRIBE_MAX_TOKENS }), signal,
          });
          if (text.trim()) segments.push({ speaker: findOrAddUser('mono').id, text: text.trim() });
        }
        okWindows++;
      } catch (err2) {
        if (signal?.aborted || chunks.length === 1) throw err2;
        console.warn(`[diarize] fallback for window ${i + 1} also failed:`, err2.message);
      }
      if (onProgress) onProgress(i + 1, chunks.length);
      continue;
    }

    okWindows++;
    if (!language && parsed.language) language = parsed.language;
    const meta = new Map(parsed.speakers.map((s) => [s.label.toLowerCase(), s]));
    const known = new Map(roster.map((s) => [s.label.toLowerCase(), s]));
    const localMap = new Map(); // this window's raw label → roster entry

    const resolve = (rawLabel) => {
      const key = rawLabel.toLowerCase();
      if (localMap.has(key)) return localMap.get(key);
      let sp = known.get(key);
      if (!sp && key === userLabel.toLowerCase()) sp = findOrAddUser(mode === 'stereo' ? 'mic' : 'mono');
      if (!sp) {
        const m = meta.get(key);
        const source = mode === 'mono' ? 'mono' : m?.track === 'A' ? 'mic' : 'sys';
        sp = allocSpeaker(m?.gender, source, m?.voice);
      }
      localMap.set(key, sp);
      return sp;
    };

    const windowSegs = [];
    for (const g of parsed.segments) {
      const sp = resolve(g.speaker);
      const seg = { speaker: sp.id, text: g.text };
      if (g.start !== undefined && g.end !== undefined && g.end >= g.start) {
        seg.start = round1(c.startSec + clampNum(g.start, 0, chunkDur));
        seg.end = round1(c.startSec + clampNum(g.end, 0, chunkDur));
      }
      windowSegs.push(seg);
      const m = meta.get(g.speaker.toLowerCase());
      if (m?.voice && !sp.isUser) sp.voice = m.voice; // refresh the recognition notes
    }
    segments.push(...collapseRepeatSegments(windowSegs));
    if (onProgress) onProgress(i + 1, chunks.length);
  }

  if (chunks.length > 0 && okWindows === 0) {
    throw new Error('Transcription failed for every part of the recording.');
  }

  // Keep only speakers that actually spoke.
  const used = new Set(segments.map((g) => g.speaker));
  const speakers = roster.filter((s) => used.has(s.id));
  return { language, speakers, segments, text: flattenSegments(speakers, segments) };
}

// --- public: title --------------------------------------------------------

async function generateTitle({ apiKey, model, transcript, signal }) {
  const text = (transcript || '').trim().slice(0, 6000);
  if (!text) return '';
  const prompt =
    'Write a short, specific title (3 to 6 words) that summarizes what this recording ' +
    'is about. Use Title Case. No surrounding quotes, no trailing punctuation. Output ' +
    'only the title.\n\nTranscript:\n' +
    text;
  // Thinking models spend output tokens reasoning before the title, so give them
  // ample room; non-thinking models emit the title directly and need very little.
  const maxOutputTokens = thinksByDefault(model) ? 2048 : 64;
  const out = await callGenerate({
    apiKey,
    model,
    parts: [{ text: prompt }],
    generationConfig: genConfig(model, { temperature: 0.2, maxOutputTokens }),
    signal,
  });
  return (out || '')
    .split('\n')[0]
    .replace(/^["'#\s*-]+|["'\s]+$/g, '')
    .slice(0, 80)
    .trim();
}

// --- public: embeddings ---------------------------------------------------

async function embedText({ apiKey, text, signal }) {
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const res = await fetch(`${HOST}/v1beta/models/${EMBED_MODEL}:embedContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: (text || '').slice(0, 8000) }] },
      outputDimensionality: EMBED_DIM,
    }),
    signal,
  });
  if (!res.ok) throw new Error(await describeHttpError(res));
  const values = (await res.json())?.embedding?.values;
  if (!Array.isArray(values)) throw new Error('Gemini returned no embedding.');
  return values;
}

async function verifyKey(apiKey) {
  const res = await fetch(`${HOST}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey } });
  return res.ok;
}

module.exports = {
  transcribeFile,
  transcribeConversation,
  transcribeConversationChunked,
  diarizeChunked,
  flattenSegments,
  cleanLabeledTranscript,
  generateTitle,
  embedText,
  verifyKey,
  INLINE_MAX_BYTES,
  TRANSCRIBE_PROMPT,
};
