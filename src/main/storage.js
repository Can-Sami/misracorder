'use strict';

// Storage: where recordings live on disk and how the app reads its history.
//
// Layout (source of truth is the filesystem; recordings.json is a fast index):
//
//   <root>/                         default: ~/Documents/Misracorder
//     recordings.json               manifest — array of records, newest first
//     2026/06/28/
//       20260628-143005-ab12.wav    the audio
//       20260628-143005-ab12.txt    the transcript (written when Gemini returns)
//       20260628-143005-ab12.json   per-recording metadata sidecar
//
// A recording's three artifacts share one base name so they stay together in Finder.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const gemini = require('./gemini'); // flattenSegments — segments → "Label: text" lines

const MANIFEST_NAME = 'recordings.json';

let rootDir = path.join(os.homedir(), 'Documents', 'Misracorder');

function getRoot() {
  return rootDir;
}

function setRoot(dir) {
  if (dir && typeof dir === 'string') rootDir = dir;
  return rootDir;
}

function manifestPath() {
  return path.join(rootDir, MANIFEST_NAME);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Build the calendar path pieces from a Date.
function dateParts(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return { yyyy, mm, dd, hh, mi, ss };
}

function shortId() {
  // 4 chars of url-safe-ish randomness; collisions within a second are vanishingly rare.
  return Math.random().toString(36).slice(2, 6);
}

// --- manifest -------------------------------------------------------------

async function loadManifest() {
  try {
    const raw = await fsp.readFile(manifestPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // Corrupt manifest: don't lose the file, but don't crash the app either.
    console.error('[storage] manifest unreadable, starting empty:', err.message);
    return [];
  }
}

async function saveManifest(records) {
  await ensureDir(rootDir);
  const tmp = manifestPath() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await fsp.rename(tmp, manifestPath()); // atomic replace
}

async function upsertRecord(record) {
  const records = await loadManifest();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx === -1) records.unshift(record);
  else records[idx] = record;
  await saveManifest(records);
  return record;
}

async function getRecord(id) {
  const records = await loadManifest();
  return records.find((r) => r.id === id) || null;
}

// --- writing a new recording ---------------------------------------------

// Persist a freshly captured WAV. `wavBuffer` is a Node Buffer (16-bit PCM WAV).
// Returns the manifest record (status: 'transcribing').
async function createRecording({ wavBuffer, durationSec, device, model, createdAtISO, peaks, channels, micName, sysName, hasSystemAudio }) {
  const date = createdAtISO ? new Date(createdAtISO) : new Date();
  const { yyyy, mm, dd, hh, mi, ss } = dateParts(date);
  const id = `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${shortId()}`;
  const dayDir = path.join(rootDir, yyyy, mm, dd);
  await ensureDir(dayDir);

  const base = `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${id.split('-').pop()}`;
  const audioRel = path.join(yyyy, mm, dd, `${base}.wav`);
  const transcriptRel = path.join(yyyy, mm, dd, `${base}.txt`);
  const sidecarRel = path.join(yyyy, mm, dd, `${base}.json`);

  await fsp.writeFile(path.join(rootDir, audioRel), wavBuffer);

  const record = {
    id,
    createdAt: date.toISOString(),
    year: yyyy,
    month: mm,
    day: dd,
    audioPath: audioRel,
    transcriptPath: transcriptRel,
    durationSec: Math.round((durationSec || 0) * 10) / 10,
    device: device || 'Unknown microphone',
    model: model || null,
    status: 'transcribing',
    title: defaultTitle(date),
    transcript: '',
    peaks: Array.isArray(peaks) ? peaks : [],
    channels: channels === 2 ? 2 : 1,
    micName: micName || null,
    sysName: sysName || null,
    hasSystemAudio: Boolean(hasSystemAudio),
    error: null,
  };

  await writeSidecar(sidecarRel, record);
  await upsertRecord(record);
  return record;
}

function defaultTitle(date) {
  // Human, scannable. e.g. "Jun 28, 14:30"
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function writeSidecar(sidecarRel, record) {
  const sidecar = { ...record };
  delete sidecar.transcript; // transcript lives in the .txt; keep sidecar small
  await fsp.writeFile(path.join(rootDir, sidecarRel), JSON.stringify(sidecar, null, 2), 'utf8');
}

// --- transcript updates ---------------------------------------------------

async function setTranscript(id, transcript) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const text = (transcript || '').trim();
  await fsp.writeFile(path.join(rootDir, record.transcriptPath), text + '\n', 'utf8');

  // Title is set separately (Gemini summary); don't derive it from the transcript here.
  const updated = { ...record, transcript: text, status: text ? 'done' : 'empty', error: null };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

// --- diarized transcripts ---------------------------------------------------
//
// Diarized recordings get a fourth artifact, <base>.segments.json:
//   { version, language, speakers: [{ id, label, gender, source, voice, isUser }],
//     segments: [{ speaker: <roster id>, text, start?, end? }] }
// The flattened "Label: text" transcript is STILL written to the .txt and the
// manifest, so search, previews, copy and export never need to know about
// segments. A record with `segmentsPath` set is in the new format.

function segmentsRelFor(record) {
  return record.audioPath.replace(/\.wav$/, '.segments.json');
}

async function setTranscriptAndSegments(id, { text, language, speakers, segments }) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const flat = (text || '').trim();
  const segmentsRel = segmentsRelFor(record);
  await fsp.writeFile(path.join(rootDir, record.transcriptPath), flat + '\n', 'utf8');
  await fsp.writeFile(
    path.join(rootDir, segmentsRel),
    JSON.stringify({ version: 1, language: language || '', speakers, segments }, null, 2),
    'utf8'
  );
  const updated = {
    ...record,
    transcript: flat,
    status: flat ? 'done' : 'empty',
    error: null,
    segmentsPath: segmentsRel,
    speakerCount: speakers.length,
  };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

async function readSegments(id) {
  const record = await getRecord(id);
  if (!record || !record.segmentsPath) return null;
  try {
    const data = JSON.parse(await fsp.readFile(path.join(rootDir, record.segmentsPath), 'utf8'));
    return data && Array.isArray(data.speakers) && Array.isArray(data.segments) ? data : null;
  } catch {
    return null;
  }
}

// Rename one speaker across a recording: edit the roster label, re-flatten the
// transcript so the .txt/manifest (and thus search, copy, export) pick up the
// new name, and drop the stale embedding so semantic search re-indexes.
async function renameSpeaker(id, speakerId, label) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const data = await readSegments(id);
  if (!data) throw new Error(`Recording ${id} has no speaker data`);
  const clean = (label || '').trim().slice(0, 60);
  if (!clean) return record;
  const speaker = data.speakers.find((s) => s.id === speakerId);
  if (!speaker) throw new Error(`No speaker ${speakerId} in ${id}`);
  speaker.label = clean;
  await fsp.writeFile(path.join(rootDir, record.segmentsPath), JSON.stringify(data, null, 2), 'utf8');

  const flat = gemini.flattenSegments(data.speakers, data.segments);
  await fsp.writeFile(path.join(rootDir, record.transcriptPath), flat + '\n', 'utf8');
  await deleteEmbedding(id);
  const updated = { ...record, transcript: flat };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

// Rename a recording. Marks the title as user-set so transcription won't override it.
async function setTitle(id, title) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const clean = (title || '').trim();
  const updated = { ...record, title: clean || record.title, customTitle: true };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

// --- cloud sharing pointers --------------------------------------------------
// A recording that has been uploaded remembers its cloud identity so re-shares
// upsert instead of duplicating and the UI can show share state.

async function setCloudInfo(id, cloud) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const updated = { ...record, cloud: cloud || null };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

async function clearCloudInfo(id) {
  return setCloudInfo(id, null);
}

// Set an auto-generated (Gemini) title — never overrides a user-set title.
async function setAutoTitle(id, title) {
  const record = await getRecord(id);
  if (!record || record.customTitle) return record;
  const clean = (title || '').trim();
  if (!clean) return record;
  const updated = { ...record, title: clean };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

// --- embeddings (kept in a separate file so the manifest stays small) -----

function embeddingsPath() {
  // v2: vectors are task-typed (RETRIEVAL_DOCUMENT); the old untyped file is
  // simply abandoned and everything re-indexes on first search.
  return path.join(rootDir, 'embeddings-v2.json');
}

async function loadEmbeddings() {
  try {
    const raw = await fsp.readFile(embeddingsPath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function setEmbedding(id, vector) {
  if (!Array.isArray(vector)) return;
  const all = await loadEmbeddings();
  all[id] = vector;
  await ensureDir(rootDir);
  const tmp = embeddingsPath() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(all), 'utf8');
  await fsp.rename(tmp, embeddingsPath());
}

async function deleteEmbedding(id) {
  const all = await loadEmbeddings();
  if (!(id in all)) return;
  delete all[id];
  const tmp = embeddingsPath() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(all), 'utf8');
  await fsp.rename(tmp, embeddingsPath());
}

// Persist the transcribing state at (re-)start so concurrent read-modify-write
// updates (e.g. a title rename mid-run) see the true status instead of
// reverting it, and so an interrupted run resumes on next launch.
async function setTranscribing(id) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const updated = { ...record, status: 'transcribing', error: null };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

async function setError(id, message) {
  const record = await getRecord(id);
  if (!record) throw new Error(`No recording ${id}`);
  const updated = { ...record, status: 'error', error: String(message || 'Transcription failed') };
  await writeSidecarFor(updated);
  await upsertRecord(updated);
  return updated;
}

async function writeSidecarFor(record) {
  const sidecarRel = record.audioPath.replace(/\.wav$/, '.json');
  await writeSidecar(sidecarRel, record);
}

function deriveTitle(text) {
  if (!text) return null;
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  const clipped = firstLine.length > 64 ? firstLine.slice(0, 63).trimEnd() + '…' : firstLine;
  return clipped;
}

// --- reading transcript on demand ----------------------------------------

async function readTranscript(id) {
  const record = await getRecord(id);
  if (!record) return '';
  try {
    return await fsp.readFile(path.join(rootDir, record.transcriptPath), 'utf8');
  } catch {
    return '';
  }
}

// --- deletion -------------------------------------------------------------

async function deleteRecording(id) {
  const record = await getRecord(id);
  if (!record) return false;
  for (const rel of [
    record.audioPath,
    record.transcriptPath,
    record.audioPath.replace(/\.wav$/, '.json'),
    segmentsRelFor(record),
  ]) {
    try {
      await fsp.unlink(path.join(rootDir, rel));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[storage] delete failed:', rel, err.message);
    }
  }
  const records = (await loadManifest()).filter((r) => r.id !== id);
  await saveManifest(records);
  return true;
}

// Absolute path for a record's audio (used to reveal in Finder / play).
function absAudioPath(record) {
  return path.join(rootDir, record.audioPath);
}

module.exports = {
  getRoot,
  setRoot,
  ensureDir,
  loadManifest,
  createRecording,
  setTranscript,
  setTranscriptAndSegments,
  readSegments,
  renameSpeaker,
  setTitle,
  setAutoTitle,
  setCloudInfo,
  clearCloudInfo,
  loadEmbeddings,
  setEmbedding,
  deleteEmbedding,
  setTranscribing,
  setError,
  readTranscript,
  deleteRecording,
  getRecord,
  absAudioPath,
};
