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

function extractText(data) {
  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Audio was blocked by safety filters (${data.promptFeedback.blockReason}).`);
  }
  const cand = data?.candidates?.[0];
  if (!cand) throw new Error('Gemini returned no candidates.');
  const parts = cand.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS' && !text) {
    throw new Error(`Generation stopped early (${cand.finishReason}).`);
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

async function callGenerate({ apiKey, model, parts, generationConfig, signal }) {
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
  return extractText(await res.json());
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

// Transcribe one mic+system window into speaker-labeled lines (internal helper).
async function transcribePair({ apiKey, model, micBuffer, sysBuffer, prompt, signal }) {
  const inline = micBuffer.length + sysBuffer.length <= PAIR_INLINE_MAX;
  const micPart = inline ? inlinePart(micBuffer) : await filePart({ apiKey, buffer: micBuffer, signal });
  const sysPart = inline ? inlinePart(sysBuffer) : await filePart({ apiKey, buffer: sysBuffer, signal });
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
  cleanLabeledTranscript,
  generateTitle,
  embedText,
  verifyKey,
  INLINE_MAX_BYTES,
  TRANSCRIBE_PROMPT,
};
