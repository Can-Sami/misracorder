import { Recorder } from './recorder.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const app = $('app');
const audio = $('audio');

// ---------------------------------------------------------------- state
const state = {
  settings: { hasApiKey: false, model: 'gemini-3.5-flash', apiKeySource: 'none', theme: 'system', shortcut: '' },
  devices: [],
  deviceMode: localStorage.getItem('misra.deviceMode') || 'auto', // 'auto' | 'manual'
  deviceId: localStorage.getItem('misra.deviceId') || 'default', // pinned device when manual
  activeDeviceId: null, // device the current recording is actually using
  deviceLabel: 'Default microphone',
  records: [],
  selectedId: null,
  audioId: null, // which recording is loaded in the shared <audio>
  query: '',
  period: 'all', // all | today | week | month
  sort: 'new', // new | old
  recording: false,
  capturing: false, // keybind capture mode
  recordingSysName: null, // app name captured for the current recording's system audio
  systemAudioRouted: false, // a Multi-Output Device is active for this recording
  micLocked: false, // we deliberately chose the mic — don't auto-switch it
  semantic: localStorage.getItem('misra.semantic') === '1', // semantic search on/off
  embeddings: null, // { id: vector } cache
  semanticOrder: null, // [{ id, score }] for the current semantic query
  progress: {}, // id -> { done, total } chunk progress while (re-)transcribing
  segments: {}, // id -> segments data (or null once fetched and absent)
  view: 'mine', // 'mine' | 'inbox' — which library the list shows
  inbox: { items: [], unread: 0 }, // shares to me (pushed from main)
  sharedDetail: null, // inbox item open in the detail sheet (read-only mode)
  shareFor: null, // recording id the share sheet is about
  shareInfo: null, // latest share:status for shareFor
  shareRoster: [], // [{ id, displayName }] cached for the recipient picker
};

let recorder = null;
let rafId = 0;
let waveCtx = null;
const waveBuffer = new Array(72).fill(0);

// ---------------------------------------------------------------- icons
const ICON = {
  play: '<svg class="ic-play" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg class="ic-pause" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  rename: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 19h3l9.5-9.5-3-3L5 16v3zM14.5 6l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  finder: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M6.5 7l1 12h9l1-12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5M6 12v7h12v-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.7 1.23A3.4 3.4 0 0 1 16.6 18z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

// ---------------------------------------------------------------- helpers
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fileUrl(p) {
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Best-effort clipboard write: throws when the window isn't focused (e.g. the
// user switched apps mid-action) — that must never abort the calling flow.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatShortcut(accel) {
  const map = { CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '⌘', Return: '⏎' };
  return (accel || '')
    .split('+')
    .map((t) => map[t] || t)
    .join('');
}

// ---------------------------------------------------------------- entries
function entryText(rec) {
  if (rec.status === 'transcribing') return { text: 'Transcribing…', cls: 'is-pending' };
  if (rec.status === 'no_key') return { text: 'Add an API key to transcribe this recording.', cls: 'is-error' };
  if (rec.status === 'error') return { text: rec.error || 'Transcription failed — open to retry.', cls: 'is-error' };
  const t = (rec.transcript || '').trim();
  if (!t) return { text: 'No speech detected.', cls: 'is-pending' };
  return { text: t, cls: '' };
}

function entryHtml(rec) {
  const pv = entryText(rec);
  const selected = rec.id === state.selectedId ? ' selected' : '';
  const title = rec.title || timeLabel(rec.createdAt);
  return `
    <div class="entry${selected}" data-id="${rec.id}" role="button" tabindex="0">
      <div class="entry-meta">
        <button class="entry-play" data-act="play" title="Play" aria-label="Play recording">${ICON.play}${ICON.pause}</button>
        <div class="entry-cap">${timeLabel(rec.createdAt)}<br>${fmtDuration(rec.durationSec)}</div>
      </div>
      <div class="entry-body">
        <div class="entry-title">${escapeHtml(title)}${rec.cloud ? `<span class="shared-mark" title="In the cloud">${ICON.cloud}</span>` : ''}</div>
        <div class="entry-preview ${pv.cls}">${escapeHtml(pv.text)}</div>
      </div>
      <div class="entry-actions">
        <button class="act" data-act="copy" title="Copy transcript">${ICON.copy}</button>
        <button class="act" data-act="more" title="More">${ICON.more}</button>
      </div>
    </div>`;
}

function filteredRecords() {
  let recs = state.records.slice();
  // time period
  if (state.period !== 'all') {
    const now = Date.now();
    recs = recs.filter((r) => {
      const t = new Date(r.createdAt);
      if (state.period === 'today') return t.toDateString() === new Date().toDateString();
      const days = state.period === 'week' ? 7 : 30;
      return now - t.getTime() <= days * 86400000;
    });
  }

  if (state.query) {
    if (state.semantic && state.semanticOrder) {
      // rank by semantic similarity (period filter already applied above)
      const scoreById = new Map(state.semanticOrder.map((s) => [s.id, s.score]));
      return recs.filter((r) => scoreById.has(r.id)).sort((a, b) => scoreById.get(b.id) - scoreById.get(a.id));
    }
    const q = state.query.toLowerCase();
    recs = recs.filter((r) => `${r.title || ''} ${r.transcript || ''}`.toLowerCase().includes(q));
  }

  recs.sort((a, b) =>
    state.sort === 'old'
      ? new Date(a.createdAt) - new Date(b.createdAt)
      : new Date(b.createdAt) - new Date(a.createdAt)
  );
  return recs;
}

// --- semantic search ---
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let semanticTimer = 0;
function scheduleSemantic() {
  clearTimeout(semanticTimer);
  semanticTimer = setTimeout(runSemanticSearch, 350);
}

async function runSemanticSearch() {
  const q = state.query;
  if (!q || !state.semantic) return;
  if (!state.embeddings) state.embeddings = await api.getEmbeddings();
  // Nothing indexed yet → index now, then continue (covers searching mid-indexing).
  if (!state.embeddings || !Object.keys(state.embeddings).length) {
    toast('Indexing recordings for semantic search…');
    await api.backfillEmbeddings();
    state.embeddings = await api.getEmbeddings();
  }
  const res = await api.embedQuery(q);
  if (!res || !res.ok) {
    toast(
      res && res.reason === 'no_key'
        ? 'Add a Gemini API key to use semantic search.'
        : `Semantic search unavailable: ${(res && res.error) || 'unknown error'}`
    );
    state.semantic = false;
    updateSemanticToggle();
    renderHistory();
    return;
  }
  const qv = res.vector;
  const order = Object.entries(state.embeddings || {})
    .map(([id, vec]) => ({ id, score: cosine(qv, vec) }))
    .sort((a, b) => b.score - a.score);
  const strong = order.filter((o) => o.score >= 0.6).slice(0, 50);
  state.semanticOrder = strong.length ? strong : order.slice(0, 10);
  renderHistory();
}

function updateSemanticToggle() {
  const btn = $('semanticToggle');
  if (btn) btn.classList.toggle('active', state.semantic);
}

async function toggleSemantic() {
  state.semantic = !state.semantic;
  localStorage.setItem('misra.semantic', state.semantic ? '1' : '0');
  updateSemanticToggle();
  if (state.semantic) {
    toast('Semantic search on — indexing recordings…');
    const res = await api.backfillEmbeddings();
    state.embeddings = await api.getEmbeddings();
    if (res && res.added) toast(`Indexed ${res.added} recording${res.added === 1 ? '' : 's'}.`);
    if (state.query) runSemanticSearch();
  } else {
    state.semanticOrder = null;
    renderHistory();
  }
}

function renderHistory() {
  const groups = $('groups');
  const empty = $('emptyState');
  const searchEmpty = $('searchEmpty');
  const connected = Boolean(state.settings.cloudConnected);

  // The view switcher only exists once sharing is connected.
  $('viewSeg').hidden = !connected;
  if (!connected && state.view !== 'mine') state.view = 'mine';

  if (state.view === 'inbox') {
    renderInbox();
    return;
  }
  $('inboxGroups').hidden = true;
  $('inboxEmpty').hidden = true;
  groups.hidden = false;

  // search + filters only make sense once there's something to look through
  const hasRecords = state.records.length > 0;
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.hidden = !hasRecords && !connected;
  document.querySelector('.search').hidden = !hasRecords;
  $('filters').hidden = !hasRecords;

  if (!hasRecords) {
    empty.hidden = false;
    searchEmpty.hidden = true;
    groups.innerHTML = '';
    return;
  }
  empty.hidden = true;

  const recs = filteredRecords();
  if (!recs.length) {
    searchEmpty.hidden = false;
    groups.innerHTML = '';
    return;
  }
  searchEmpty.hidden = true;

  // Semantic search → a flat list ranked by relevance (don't regroup by day).
  if (state.semantic && state.query && state.semanticOrder) {
    groups.innerHTML =
      `<section class="group"><div class="group-head">Best matches</div>` +
      recs.map(entryHtml).join('') +
      `</section>`;
    updatePlayingUI();
    return;
  }

  const byDay = new Map();
  for (const rec of recs) {
    const key = dayLabel(rec.createdAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(rec);
  }
  let html = '';
  for (const [label, list] of byDay) {
    html += `<section class="group"><div class="group-head">${label}</div>`;
    html += list.map(entryHtml).join('');
    html += '</section>';
  }
  groups.innerHTML = html;
  updatePlayingUI();
}

function upsertRecord(rec) {
  const idx = state.records.findIndex((r) => r.id === rec.id);
  if (idx === -1) state.records.unshift(rec);
  else state.records[idx] = { ...state.records[idx], ...rec };
  renderHistory();
  if (state.selectedId === rec.id) renderDetail(state.records.find((r) => r.id === rec.id));
}

// ---------------------------------------------------------------- inbox
// "Shared with me": recordings friends shared to this user. Items are pushed
// from main (poll) via inbox:state; audio is downloaded on demand and played
// from a local cache like any recording.

function setView(view) {
  state.view = view;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  renderHistory();
}

function inboxEntryHtml(item) {
  const preview = (item.transcript?.text || '').trim() || 'No transcript.';
  return `
    <div class="entry inbox-entry${item.seen ? '' : ' unseen'}" data-share="${escapeHtml(item.shareId)}" role="button" tabindex="0">
      <div class="entry-meta">
        <button class="entry-play" data-act="playShared" title="Play" aria-label="Play recording">${ICON.play}${ICON.pause}</button>
        <div class="entry-cap">${fmtDuration(item.durationSec)}</div>
      </div>
      <div class="entry-body">
        <div class="entry-title">${item.seen ? '' : '<span class="unread-dot inline"></span>'}${escapeHtml(item.title || 'Untitled')}</div>
        <div class="entry-from">from ${escapeHtml(item.from)} · ${dayLabel(item.createdAt)}</div>
        <div class="entry-preview">${escapeHtml(preview)}</div>
      </div>
    </div>`;
}

function renderInbox() {
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.hidden = false;
  document.querySelector('.search').hidden = true;
  $('filters').hidden = true;
  $('groups').hidden = true;
  $('emptyState').hidden = true;
  $('searchEmpty').hidden = true;

  const list = $('inboxGroups');
  const items = state.inbox.items;
  $('inboxEmpty').hidden = items.length > 0;
  list.hidden = false;
  list.innerHTML = items.length
    ? `<section class="group"><div class="group-head">Shared with me</div>${items.map(inboxEntryHtml).join('')}</section>`
    : '';
  updatePlayingUI();
}

function inboxItem(shareId) {
  return state.inbox.items.find((i) => i.shareId === shareId);
}

// Download (or reuse cached) audio for a shared item and load it into the
// shared <audio> element. Returns true when ready.
async function loadSharedAudio(shareId) {
  const key = `shared:${shareId}`;
  if (state.audioId === key && audio.src) return true;
  const res = await api.inboxPlay(shareId);
  if (!res.ok) {
    toast(res.reason === 'offline' ? 'You’re offline — can’t fetch this recording.' : 'Could not fetch this recording.');
    return false;
  }
  audio.src = fileUrl(res.localPath);
  state.audioId = key;
  audio.load();
  return true;
}

async function togglePlayShared(shareId) {
  if (!(await loadSharedAudio(shareId))) return;
  if (audio.paused) {
    try {
      await audio.play();
    } catch {
      /* ignore */
    }
  } else {
    audio.pause();
  }
  updatePlayingUI();
  const item = inboxItem(shareId);
  if (item && !item.seen) api.inboxMarkSeen(shareId);
}

// Open a shared recording in the detail sheet, read-only.
async function openSharedDetail(shareId) {
  const item = inboxItem(shareId);
  if (!item) return;
  state.sharedDetail = item;
  state.selectedId = null;
  renderSharedDetail(item);
  $('detail').classList.add('open', 'shared');
  $('detail').setAttribute('aria-hidden', 'false');
  app.classList.add('sheet-open');
  if (!item.seen) api.inboxMarkSeen(shareId);
  await loadSharedAudio(shareId);
  $('scrubFill').style.width = '0%';
  $('scrubKnob').style.left = '0%';
  $('ptime').textContent = fmtDuration(0);
  updatePlayingUI();
}

// Turn view for a shared transcript payload ({ format, text, speakers?, segments? }).
function sharedTurnsHtml(payload) {
  if (payload?.format !== 'segments' || !Array.isArray(payload.segments)) return '';
  const speakers = Array.isArray(payload.speakers) ? payload.speakers : [];
  const hues = new Map();
  let i = 0;
  for (const s of speakers) hues.set(s.label, s.isUser ? USER_HUE : SPEAKER_HUES[i++ % SPEAKER_HUES.length]);
  const turns = [];
  for (const seg of payload.segments) {
    if (!seg || !seg.text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.texts.push(seg.text);
    else turns.push({ speaker: seg.speaker || 'Speaker', texts: [seg.text] });
  }
  if (!turns.length) return '';
  return (
    `<div class="turns">` +
    turns
      .map((t) => {
        if (!hues.has(t.speaker)) hues.set(t.speaker, SPEAKER_HUES[i++ % SPEAKER_HUES.length]);
        return `
      <div class="turn" style="--sp-h: ${hues.get(t.speaker)}">
        <span class="speaker-chip">${escapeHtml(t.speaker)}</span>
        <div class="turn-text">${escapeHtml(t.texts.join(' '))}</div>
      </div>`;
      })
      .join('') +
    `</div>`
  );
}

function renderSharedDetail(item) {
  const title = $('detailTitle');
  title.value = item.title || 'Untitled';
  title.readOnly = true;
  $('detailSub').textContent = `from ${item.from}  ·  ${new Date(item.recordedAt || item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  ·  ${fmtDuration(item.durationSec)}`;
  const bodyEl = $('transcriptBody');
  bodyEl.classList.remove('placeholder');
  const turns = sharedTurnsHtml(item.transcript);
  const text = (item.transcript?.text || '').trim();
  if (turns) bodyEl.innerHTML = turns;
  else if (text) bodyEl.textContent = text;
  else {
    bodyEl.textContent = 'No transcript came with this recording.';
    bodyEl.classList.add('placeholder');
  }
}

// ---------------------------------------------------------------- recording
async function startRecording() {
  if (state.recording) return;
  const access = await api.ensureMicAccess();
  if (access.status !== 'granted') {
    toast('Microphone access is needed. Opening System Settings…');
    api.openMicSettings();
    return;
  }
  recorder = new Recorder({ onLevel: (lvl, meta) => onLevel(lvl, meta) });
  let dev = resolveDeviceId();
  const wantSystemAudio = state.settings.systemAudio !== false;
  state.systemAudioRouted = false;
  state.micLocked = false;

  // Route the Mac's output through BlackHole for this recording (auto Multi-Output
  // Device of "what you're listening on + BlackHole"). On Bluetooth, switch to the
  // built-in mic so the headphones keep playing hi-fi audio (using their mic would
  // force low-quality call mode and can disrupt playback).
  if (wantSystemAudio) {
    try {
      const info = await api.systemAudioBegin();
      state.systemAudioRouted = Boolean(info && info.ok);
      if (info && info.ok && info.bluetooth) {
        const bi = builtinMicDevice();
        if (bi) {
          dev = bi.deviceId;
          state.micLocked = true;
          state.deviceLabel = bi.label;
          $('deviceName').textContent = (state.deviceMode === 'auto' ? 'Auto · ' : '') + bi.label;
        }
      }
    } catch {
      /* couldn't route — recorder will fall back to mic-only */
    }
  }

  try {
    await recorder.start(dev, { systemAudio: wantSystemAudio, systemDeviceId: resolveSystemDeviceId() });
  } catch (err) {
    console.error(err);
    toast('Could not start the microphone.');
    if (state.systemAudioRouted) {
      api.systemAudioEnd().catch(() => {});
      state.systemAudioRouted = false;
    }
    state.micLocked = false;
    recorder = null;
    return;
  }
  state.activeDeviceId = dev;
  state.recording = true;
  // Capture (best-effort) the app whose audio we're recording, for speaker labels.
  state.recordingSysName = null;
  if (wantSystemAudio) {
    api.audioSourceName().then((n) => (state.recordingSysName = n)).catch(() => {});
  }
  app.classList.add('recording');
  $('recordBtn').setAttribute('aria-label', 'Stop recording');
  $('timer').hidden = false;
  $('cancelBtn').hidden = false;
  waveBuffer.fill(0);
  startWaveLoop();

  // Let the user know if system audio was wanted but couldn't be captured.
  if (wantSystemAudio && recorder && !recorder.systemAudioActive) {
    toast('System audio capture is unavailable here — recording your mic only.');
  }
}

async function stopRecording(savePolicy = 'save') {
  if (!state.recording || !recorder) return;
  state.recording = false;
  app.classList.remove('recording');
  $('recordBtn').setAttribute('aria-label', 'Start recording');
  $('timer').hidden = true;
  $('cancelBtn').hidden = true;
  $('recordBtn').style.setProperty('--level', '0');
  stopWaveLoop();

  // Always restore the user's normal output device + tear down the Multi-Output
  // Device once capture stops, no matter how we exit.
  const deviceUsed = state.deviceLabel; // capture before restore re-resolves the pill
  const wasRouted = state.systemAudioRouted;
  state.systemAudioRouted = false;
  state.micLocked = false;
  const restoreOutput = () => (wasRouted ? api.systemAudioEnd().catch(() => {}) : Promise.resolve());

  if (savePolicy === 'cancel') {
    await recorder.cancel();
    recorder = null;
    await restoreOutput();
    return;
  }
  const result = await recorder.stop();
  recorder = null;
  await restoreOutput();
  if (!result || result.durationSec < 0.4) {
    toast('Recording was too short.');
    return;
  }
  try {
    const rec = await api.saveRecording({
      wav: result.wav,
      durationSec: result.durationSec,
      device: deviceUsed,
      peaks: result.peaks,
      channels: result.channels,
      micName: state.settings.userName || 'Me',
      sysName: state.recordingSysName || null,
      hasSystemAudio: result.channels === 2,
    });
    upsertRecord(rec);
    if (!state.settings.hasApiKey) toast('Saved. Add a Gemini API key to transcribe.');
  } catch (err) {
    console.error(err);
    toast('Could not save the recording.');
  }
}

function onLevel(_lvl, meta) {
  if (meta && meta.lost) handleMicLost();
}

// ---------------------------------------------------------------- waveform
function setupCanvas() {
  waveCtx = $('waveform').getContext('2d');
}

function startWaveLoop() {
  const canvas = $('waveform');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 500;
  const cssH = canvas.clientHeight || 48;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const step = () => {
    if (!state.recording) return;
    const lvl = recorder ? recorder.level : 0;
    waveBuffer.push(lvl);
    waveBuffer.shift();
    drawWave(dpr, cssW, cssH);
    // feed the orb's audio-reactive bloom
    $('recordBtn').style.setProperty('--level', String(Math.min(1, lvl * 3.5)));
    $('timer').textContent = fmtDuration(recorder ? recorder.elapsedSec : 0);
  };
  if (reduce) {
    rafId = setInterval(step, 120);
  } else {
    const tick = () => {
      step();
      if (state.recording) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
}

function stopWaveLoop() {
  cancelAnimationFrame(rafId);
  clearInterval(rafId);
  rafId = 0;
  if (waveCtx) {
    const c = $('waveform');
    waveCtx.clearRect(0, 0, c.width, c.height);
  }
}

function drawWave(dpr, w, h) {
  const ctx = waveCtx;
  ctx.clearRect(0, 0, w * dpr, h * dpr);
  ctx.save();
  ctx.scale(dpr, dpr);
  const n = waveBuffer.length;
  const gap = 2.5;
  const barW = Math.max(2, (w - gap * (n - 1)) / n);
  const mid = h / 2;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--live').trim() || '#ff6b57';
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, waveBuffer[i] * 3.2);
    const bh = Math.max(2, v * (h - 4));
    const x = i * (barW + gap);
    roundRect(ctx, x, mid - bh / 2, barW, bh, barW / 2);
    ctx.globalAlpha = 0.25 + 0.75 * (i / n);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- audio (shared)
async function ensureLoaded(id) {
  if (state.audioId === id && audio.src) return;
  const p = await api.getAudioPath(id);
  if (!p) return;
  audio.src = fileUrl(p);
  state.audioId = id;
  audio.load();
}

async function togglePlay(id) {
  await ensureLoaded(id);
  if (audio.paused) {
    try {
      await audio.play();
    } catch {
      /* ignore */
    }
  } else {
    audio.pause();
  }
  updatePlayingUI();
}

function updatePlayingUI() {
  const playing = !audio.paused && !audio.ended;
  document.querySelectorAll('.entry.playing').forEach((e) => e.classList.remove('playing'));
  if (playing && state.audioId) {
    const el = document.querySelector(`.entry[data-id="${state.audioId}"]`);
    if (el) el.classList.add('playing');
  }
  app.classList.toggle('playing-detail', playing && state.audioId === state.selectedId && state.selectedId != null);
}

// ---------------------------------------------------------------- row actions
function recordById(id) {
  return state.records.find((r) => r.id === id);
}

async function copyTranscript(id) {
  const rec = recordById(id);
  const text = (rec && rec.transcript) || '';
  if (!text.trim()) return toast('No transcript to copy yet.');
  if (await copyText(text)) toast('Transcript copied.');
}

async function copySharedTranscript(item) {
  const text = (item.transcript?.text || '').trim();
  if (!text) return toast('No transcript to copy.');
  if (await copyText(text)) toast('Transcript copied.');
}

async function exportTranscriptFor(id) {
  const rec = recordById(id);
  if (!rec || !(rec.transcript || '').trim()) return toast('No transcript to save yet.');
  const res = await api.exportTranscript(id);
  if (res.ok) toast('Transcript saved.');
  else if (res.reason === 'empty') toast('No transcript to save yet.');
}

async function deleteRecording(id) {
  const rec = recordById(id);
  const hasCloud = Boolean(rec && rec.cloud);
  if (hasCloud && !confirm('Delete this recording? Its cloud copy and all shares will be removed too.')) return;
  await api.deleteRecording(id, hasCloud);
  if (state.audioId === id) {
    audio.pause();
    audio.removeAttribute('src');
    state.audioId = null;
  }
  delete state.segments[id];
  state.records = state.records.filter((r) => r.id !== id);
  if (state.selectedId === id) closeDetail();
  renderHistory();
  toast('Recording deleted.');
}

function openRowMenu(id, anchor) {
  const menu = $('rowMenu');
  menu.dataset.id = id;
  const shareItem = state.settings.cloudConnected
    ? `<button class="menu-item" data-act="share">${ICON.share} Share…</button>`
    : '';
  menu.innerHTML = `
    <button class="menu-item" data-act="rename">${ICON.rename} Rename…</button>
    ${shareItem}
    <button class="menu-item" data-act="copy">${ICON.copy} Copy transcript</button>
    <button class="menu-item" data-act="export">${ICON.save} Save transcript…</button>
    <button class="menu-item" data-act="reveal">${ICON.finder} Show in Finder</button>
    <button class="menu-item danger" data-act="delete">${ICON.trash} Delete</button>`;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(12, Math.min(r.right - mw, window.innerWidth - mw - 12)) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
}

function closeRowMenu() {
  $('rowMenu').hidden = true;
}

// ---------------------------------------------------------------- share sheet
// Opt-in per recording: nothing touches the cloud until Share is applied here.
// The checklist mirrors current share state; applying commits the diff (new
// checks share, cleared checks revoke), and the link toggle mints/revokes the
// public web link.

function openShareSheet(id) {
  const rec = recordById(id);
  if (!rec) return;
  state.shareFor = id;
  state.shareInfo = null;
  $('shareTitle').textContent = `Share “${rec.title || timeLabel(rec.createdAt)}”`;
  $('shareSub').textContent = '';
  $('shareProgress').textContent = '';
  $('shareSheet').classList.add('open');
  $('shareSheet').setAttribute('aria-hidden', 'false');
  app.classList.add('sheet-open');

  if (!state.settings.cloudConnected) {
    $('shareActions').hidden = true;
    $('shareBody').innerHTML =
      '<div class="share-nudge">Sharing isn’t connected yet. <span class="link" id="shareGoSettings">Connect in Settings</span> with your invite code.</div>';
    const go = $('shareGoSettings');
    if (go) go.onclick = () => {
      closeShareSheet();
      openSettings();
    };
    return;
  }

  $('shareBody').innerHTML = '<div class="share-nudge">Loading…</div>';
  $('shareActions').hidden = true;
  Promise.all([api.shareStatus(id), api.shareProfiles()]).then(([info, roster]) => {
    if (state.shareFor !== id) return; // sheet moved on
    if (!info.ok || !roster.ok) {
      $('shareBody').innerHTML = `<div class="share-nudge">${
        info.reason === 'offline' || roster.reason === 'offline'
          ? 'You’re offline — sharing needs a connection.'
          : 'Could not load sharing details.'
      }</div>`;
      return;
    }
    state.shareInfo = info;
    state.shareRoster = roster.profiles;
    renderShareSheet();
  });
}

function renderShareSheet() {
  const info = state.shareInfo;
  const sharedIds = new Set((info.sharedWith || []).map((p) => p.id));
  const people = state.shareRoster.length
    ? state.shareRoster
        .map(
          (p) => `
      <label class="share-person">
        <span class="share-avatar">${escapeHtml((p.displayName || '?')[0].toUpperCase())}</span>
        <span class="share-name">${escapeHtml(p.displayName)}</span>
        <input type="checkbox" class="share-check" data-id="${escapeHtml(p.id)}" ${sharedIds.has(p.id) ? 'checked' : ''} />
      </label>`
        )
        .join('')
    : '<p class="field-hint">No one else has connected yet.</p>';

  $('shareBody').innerHTML = `
    <div class="share-section">
      <div class="share-section-title">People</div>
      <div class="share-people">${people}</div>
    </div>
    <div class="share-section">
      <div class="share-section-title">Public link</div>
      <label class="switch-row share-link-row">
        <span class="switch-text">
          <span class="switch-title">Anyone with the link</span>
          <span class="switch-sub">A web page with the player and transcript. Revoke any time.</span>
        </span>
        <input type="checkbox" id="shareLinkToggle" class="switch" ${info.link ? 'checked' : ''} />
      </label>
      ${info.link ? `<div class="share-url-row"><input type="text" readonly id="shareUrl" value="${escapeHtml(info.link.url)}" /><button class="ghost" id="copyLinkBtn">Copy</button></div>` : ''}
    </div>`;
  $('shareActions').hidden = false;
  $('shareRemoveCloudBtn').hidden = !info.uploaded;
  $('shareApplyBtn').disabled = false;
  $('shareApplyBtn').textContent = info.uploaded ? 'Apply' : 'Share';
  const copyBtn = $('copyLinkBtn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (await copyText(info.link.url)) toast('Link copied.');
    };
  }
}

async function applyShare() {
  const id = state.shareFor;
  const info = state.shareInfo;
  if (!id || !info) return;
  const checked = [...document.querySelectorAll('.share-check')].filter((c) => c.checked).map((c) => c.dataset.id);
  const before = new Set((info.sharedWith || []).map((p) => p.id));
  const toAdd = checked.filter((rid) => !before.has(rid));
  const toRemove = [...before].filter((rid) => !checked.includes(rid));
  const wantLink = Boolean($('shareLinkToggle')?.checked);
  const makeLink = wantLink && !info.link;

  const btn = $('shareApplyBtn');
  btn.disabled = true;
  let result = info;
  if (toAdd.length || makeLink || !info.uploaded) {
    result = await api.shareCreate({ id, recipientIds: toAdd, makeLink });
  }
  for (const rid of toRemove) result = await api.shareRevokeUser(id, rid);
  if (!wantLink && info.link) result = await api.shareRevokeLink(id);
  if (state.shareFor !== id) return; // sheet moved to another recording mid-flight
  $('shareProgress').textContent = '';

  if (!result.ok) {
    btn.disabled = false;
    toast(
      result.reason === 'offline'
        ? 'You’re offline — sharing needs a connection.'
        : result.reason === 'too_large'
          ? 'This recording is too large to upload.'
          : 'Sharing failed — try again.'
    );
    return;
  }

  state.shareInfo = result;
  state.records = await api.listRecordings(); // pick up the record's new cloud pointer
  renderHistory();
  const newLink = !info.link && result.link;
  if (newLink) {
    const copied = await copyText(result.link.url);
    toast(toAdd.length ? `Shared with ${toAdd.length}${copied ? ' · link copied' : ''}.` : copied ? 'Link copied.' : 'Link created.');
  } else if (toAdd.length || toRemove.length) {
    toast('Sharing updated.');
  }
  renderShareSheet();
}

async function removeFromCloud() {
  const id = state.shareFor;
  if (!id) return;
  if (!confirm('Remove this recording from the cloud? All shares and the link stop working. The local recording stays.')) return;
  const res = await api.shareDeleteCloud(id);
  if (!res.ok) return toast('Could not remove the cloud copy.');
  state.records = await api.listRecordings();
  renderHistory();
  toast('Removed from cloud.');
  if (state.shareFor === id) closeShareSheet(); // don't close a sheet opened for another recording
}

function closeShareSheet() {
  $('shareSheet').classList.remove('open');
  $('shareSheet').setAttribute('aria-hidden', 'true');
  state.shareFor = null;
  if (!$('detail').classList.contains('open') && !$('settings').classList.contains('open')) {
    app.classList.remove('sheet-open');
  }
}

const SHARE_PHASES = {
  converting: 'Converting audio…',
  uploading: 'Uploading…',
  saving: 'Saving…',
  downloading: 'Downloading…',
};

// ---------------------------------------------------------------- detail
async function openDetail(id) {
  const rec = recordById(id);
  if (!rec) return;
  state.selectedId = id;
  state.sharedDetail = null;
  $('detail').classList.remove('shared');
  $('detailTitle').readOnly = false;
  renderHistory();
  renderDetail(rec);
  await ensureLoaded(id);
  $('scrubFill').style.width = '0%';
  $('scrubKnob').style.left = '0%';
  $('ptime').textContent = fmtDuration(0);
  updatePlayingUI();
  $('detail').classList.add('open');
  $('detail').setAttribute('aria-hidden', 'false');
  app.classList.add('sheet-open');
}

function renderDetail(rec) {
  if (!rec) return;
  // don't overwrite the field while the user is editing it
  if (document.activeElement !== $('detailTitle')) {
    $('detailTitle').value = rec.title || timeLabel(rec.createdAt);
  }
  $('detailSub').textContent = `${new Date(rec.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  ·  ${fmtDuration(rec.durationSec)}  ·  ${rec.model || ''}`.trim();

  const rb = $('retranscribeBtn');
  if (rb) {
    const busy = rec.status === 'transcribing';
    rb.disabled = busy;
    rb.textContent = busy ? 'Transcribing…' : (rec.transcript || '').trim() ? 'Re-transcribe' : 'Transcribe';
  }

  const bodyEl = $('transcriptBody');
  bodyEl.classList.remove('placeholder');
  if (rec.status === 'transcribing') {
    bodyEl.classList.add('placeholder');
    bodyEl.textContent = transcribingLabel(rec.id);
  } else if (rec.status === 'no_key') {
    bodyEl.classList.add('placeholder');
    bodyEl.innerHTML = 'No API key set. <span class="retry-link" id="goSettings">Add a Gemini API key</span> to transcribe.';
    const go = $('goSettings');
    if (go) go.onclick = openSettings;
  } else if (rec.status === 'error') {
    bodyEl.classList.add('placeholder');
    bodyEl.innerHTML = `${escapeHtml(rec.error || 'Transcription failed.')} <span class="retry-link" id="retryLink">Retry</span>`;
    const rl = $('retryLink');
    if (rl) rl.onclick = () => api.retryTranscription(rec.id);
  } else {
    const t = (rec.transcript || '').trim();
    if (!t) {
      bodyEl.textContent = 'No speech detected in this recording.';
      bodyEl.classList.add('placeholder');
      return;
    }
    const turns = turnsHtml(rec);
    if (turns) bodyEl.innerHTML = turns;
    else bodyEl.textContent = t;
  }
}

// --- diarized transcript rendering -----------------------------------------
//
// Recordings transcribed by the diarization pipeline have a segments sidecar
// (roster of speakers + per-utterance segments). Those render as turn blocks
// with a colored speaker chip; older recordings keep the plain-text view,
// except legacy stereo calls whose two channel labels are upgraded visually.

// Speaker hue assignment: "you" always gets the brand hue; everyone else draws
// from a curated wheel that stays clear of the coral reserved for recording.
const USER_HUE = 264;
const SPEAKER_HUES = [210, 160, 305, 95, 340, 250];

function speakerHues(speakers) {
  const hues = new Map();
  let i = 0;
  for (const s of speakers) hues.set(s.id, s.isUser ? USER_HUE : SPEAKER_HUES[i++ % SPEAKER_HUES.length]);
  return hues;
}

// Fetch a recording's segments once, upgrade the open detail view on arrival.
function ensureSegments(id) {
  if (id in state.segments) return state.segments[id];
  state.segments[id] = null;
  api
    .getSegments(id)
    .then((data) => {
      if (!data) return;
      state.segments[id] = data;
      if (state.selectedId === id) renderDetail(recordById(id));
    })
    .catch(() => {});
  return null;
}

function turnsHtml(rec) {
  const data = ensureSegments(rec.id);
  if (data) return segmentsTurnsHtml(data);
  return legacyTurnsHtml(rec);
}

// Consecutive segments by the same speaker merge into one calm turn block.
function segmentsTurnsHtml(data) {
  const hues = speakerHues(data.speakers);
  const labels = new Map(data.speakers.map((s) => [s.id, s.label]));
  const turns = [];
  for (const seg of data.segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.texts.push(seg.text);
    else turns.push({ speaker: seg.speaker, texts: [seg.text] });
  }
  if (!turns.length) return '';
  return (
    `<div class="turns">` +
    turns
      .map(
        (t) => `
      <div class="turn" style="--sp-h: ${hues.get(t.speaker) || 210}">
        <button class="speaker-chip" data-speaker="${escapeHtml(t.speaker)}" title="Rename this speaker">${escapeHtml(labels.get(t.speaker) || 'Speaker')}</button>
        <div class="turn-text">${escapeHtml(t.texts.join(' '))}</div>
      </div>`
      )
      .join('') +
    `</div>`
  );
}

// Legacy stereo calls: no segments file, but every line is "Mic:" or "SysApp:".
// Render those two known labels as (non-renamable) chips; anything that doesn't
// match both labels falls back to plain text.
function legacyTurnsHtml(rec) {
  if (rec.channels !== 2) return '';
  const mic = (rec.micName || '').trim();
  const sys = (rec.sysName || 'System Sound').trim();
  if (!mic || !sys) return '';
  const hue = { [mic.toLowerCase()]: USER_HUE, [sys.toLowerCase()]: SPEAKER_HUES[0] };
  const turns = [];
  for (const line of (rec.transcript || '').split('\n')) {
    if (!line.trim()) continue;
    const m = /^(.{1,40}?):\s+(.*)$/.exec(line);
    const label = m && hue[m[1].trim().toLowerCase()] !== undefined ? m[1].trim() : null;
    if (!label) return ''; // an unlabeled line → not a clean two-speaker call
    const last = turns[turns.length - 1];
    if (last && last.label === label) last.texts.push(m[2]);
    else turns.push({ label, texts: [m[2]] });
  }
  if (!turns.length) return '';
  return (
    `<div class="turns">` +
    turns
      .map(
        (t) => `
      <div class="turn" style="--sp-h: ${hue[t.label.toLowerCase()]}">
        <span class="speaker-chip">${escapeHtml(t.label)}</span>
        <div class="turn-text">${escapeHtml(t.texts.join(' '))}</div>
      </div>`
      )
      .join('') +
    `</div>`
  );
}

// --- speaker rename popover -------------------------------------------------

function openSpeakerMenu(speakerId, anchor) {
  const id = state.selectedId;
  const data = id && state.segments[id];
  if (!data) return;
  const speaker = data.speakers.find((s) => s.id === speakerId);
  if (!speaker) return;
  const menu = $('speakerMenu');
  menu.dataset.recId = id;
  menu.dataset.speakerId = speakerId;
  menu.hidden = false;
  const input = $('speakerNameInput');
  input.value = speaker.label;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 240; // matches .popover.speaker-menu width (layout may not have run yet)
  menu.style.left = Math.max(12, Math.min(r.left, window.innerWidth - mw - 12)) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
  input.focus();
  input.select();
}

function closeSpeakerMenu() {
  $('speakerMenu').hidden = true;
}

async function commitSpeakerRename() {
  const menu = $('speakerMenu');
  if (menu.hidden) return;
  const recId = menu.dataset.recId;
  const speakerId = menu.dataset.speakerId;
  const label = $('speakerNameInput').value.trim();
  closeSpeakerMenu();
  const data = state.segments[recId];
  const current = data && data.speakers.find((s) => s.id === speakerId);
  if (!label || !current || label === current.label) return;
  try {
    const updated = await api.renameSpeaker(recId, speakerId, label);
    delete state.segments[recId]; // re-read the rewritten roster
    upsertRecord(updated);
    toast(`Renamed to ${label}.`);
  } catch (err) {
    console.error(err);
    toast('Could not rename the speaker.');
  }
}

// "Transcribing…" body text, with chunk progress for long (chunked) recordings.
function transcribingLabel(id) {
  const p = state.progress[id];
  return p && p.total > 1
    ? `Transcribing with Gemini… (part ${p.done} of ${p.total})`
    : 'Transcribing with Gemini…';
}

// Re-run transcription on an existing recording (e.g. to regenerate an old
// wall-of-text transcript with the chunked pipeline). Overwrites the current
// transcript, so confirm first when there's already one worth keeping.
async function reTranscribe(id) {
  const rec = recordById(id);
  if (!rec || rec.status === 'transcribing') return;
  if (!state.settings.hasApiKey) {
    toast('Add a Gemini API key in Settings first.');
    return;
  }
  const hasText = (rec.transcript || '').trim().length > 0;
  if (hasText && !confirm('Re-transcribe this recording? The current transcript will be replaced.')) return;
  delete state.progress[id];
  try {
    const reset = await api.retryTranscription(id);
    if (reset) upsertRecord(reset);
  } catch (err) {
    console.error(err);
    toast('Could not start re-transcription.');
  }
}

async function saveTitle() {
  const id = state.selectedId;
  if (!id) return;
  const rec = recordById(id);
  if (!rec) return;
  const val = $('detailTitle').value.trim();
  if (!val || val === rec.title) {
    $('detailTitle').value = rec.title || timeLabel(rec.createdAt);
    return;
  }
  try {
    const updated = await api.setTitle(id, val);
    upsertRecord(updated);
    toast('Renamed.');
  } catch (err) {
    console.error(err);
    $('detailTitle').value = rec.title || timeLabel(rec.createdAt);
  }
}

function startRename(id) {
  openDetail(id).then(() => {
    const t = $('detailTitle');
    t.focus();
    t.select();
  });
}

function closeDetail() {
  $('detail').classList.remove('open', 'shared');
  $('detail').setAttribute('aria-hidden', 'true');
  $('detailTitle').readOnly = false;
  if (!$('settings').classList.contains('open')) app.classList.remove('sheet-open');
  audio.pause();
  state.selectedId = null;
  state.sharedDetail = null;
  updatePlayingUI();
  renderHistory();
}

function wirePlayer() {
  $('playBtn').addEventListener('click', () => state.selectedId && togglePlay(state.selectedId));
  audio.addEventListener('play', updatePlayingUI);
  audio.addEventListener('pause', updatePlayingUI);
  audio.addEventListener('ended', updatePlayingUI);
  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $('scrubFill').style.width = pct + '%';
    $('scrubKnob').style.left = pct + '%';
    $('ptime').textContent = fmtDuration(audio.currentTime);
  });
  const scrub = $('scrub');
  const seek = (e) => {
    const rect = scrub.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  };
  let dragging = false;
  scrub.addEventListener('pointerdown', (e) => {
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    seek(e);
  });
  scrub.addEventListener('pointermove', (e) => dragging && seek(e));
  scrub.addEventListener('pointerup', () => (dragging = false));
}

// ---------------------------------------------------------------- settings
async function openSettings() {
  await refreshSettings();
  $('modelSelect').value = state.settings.model;
  $('apiKeyInput').value = '';
  $('keyStatus').className = 'key-status';
  $('keyStatus').textContent = state.settings.hasApiKey
    ? state.settings.apiKeySource === 'env'
      ? 'Using a key from your environment.'
      : 'A key is saved on this Mac.'
    : '';
  $('shortcutStatus').textContent = '';
  reflectShortcut(state.settings.shortcut);
  $('systemAudioToggle').checked = state.settings.systemAudio !== false;
  $('userNameInput').value = state.settings.userName || 'Me';
  updateSystemAudioStatus();
  updateSharingSection();
  reflectThemeSeg(state.settings.theme || 'system');
  $('settings').classList.add('open');
  $('settings').setAttribute('aria-hidden', 'false');
  app.classList.add('sheet-open');
}

function closeSettings() {
  if (state.capturing) stopCapture();
  $('settings').classList.remove('open');
  $('settings').setAttribute('aria-hidden', 'true');
  if (!$('detail').classList.contains('open')) app.classList.remove('sheet-open');
}

async function refreshSettings() {
  state.settings = await api.getSettings();
  $('keyNudge').hidden = state.settings.hasApiKey;
  $('folderHint').textContent = state.settings.rootDir || 'Documents › Misracorder';
}

function updateSystemAudioStatus() {
  const el = $('systemAudioStatus');
  if (!el) return;
  if (state.settings.systemAudio === false) {
    el.className = 'key-status';
    el.textContent = '';
    return;
  }
  if (resolveSystemDeviceId()) {
    el.className = 'key-status ok';
    el.textContent = '✓ System audio ready — captured automatically while you record.';
  } else {
    el.className = 'key-status';
    el.innerHTML = 'Needs BlackHole (one-time install) to capture system audio. <span class="link" id="blackholeHelp">Get BlackHole</span>.';
    const h = $('blackholeHelp');
    if (h) h.onclick = () => api.openExternal('https://existential.audio/blackhole/');
  }
}

// --- sharing (invite code) --------------------------------------------------

function updateSharingSection() {
  const connected = Boolean(state.settings.cloudConnected);
  $('sharingDisconnected').hidden = connected;
  $('sharingConnected').hidden = !connected;
  if (connected) $('cloudNameLabel').textContent = state.settings.cloudDisplayName || '';
  $('cloudStatus').className = 'key-status';
  $('cloudStatus').textContent = '';
}

const REDEEM_ERRORS = {
  'invalid-code': 'That code wasn’t recognized.',
  'code-already-used': 'That code was already used.',
  'name-taken': 'That name is taken — pick another.',
  'missing-code': 'Enter your invite code first.',
  'missing-display-name': 'Pick a display name first.',
  offline: 'You’re offline — connecting needs a network.',
  not_configured: 'Sharing isn’t configured in this build.',
};

async function connectSharing() {
  const code = $('inviteCodeInput').value.trim();
  const name = $('displayNameInput').value.trim();
  const status = $('cloudStatus');
  if (!code || !name) {
    status.className = 'key-status bad';
    status.textContent = !code ? REDEEM_ERRORS['missing-code'] : REDEEM_ERRORS['missing-display-name'];
    return;
  }
  status.className = 'key-status';
  status.textContent = 'Connecting…';
  const res = await api.cloudRedeem(code, name);
  if (!res.ok) {
    status.className = 'key-status bad';
    status.textContent = REDEEM_ERRORS[res.reason] || 'Could not connect — try again.';
    return;
  }
  await refreshSettings();
  updateSharingSection();
  status.className = 'key-status ok';
  status.textContent = `Connected as ${res.displayName}.`;
  toast('Sharing connected.');
  renderHistory();
}

async function signOutSharing() {
  await api.cloudSignOut();
  await refreshSettings();
  state.inbox = { items: [], unread: 0 };
  $('inboxDot').hidden = true;
  if (state.view === 'inbox') setView('mine');
  updateSharingSection();
  renderHistory();
  toast('Signed out of sharing.');
}

async function saveKey() {
  const key = $('apiKeyInput').value.trim();
  const status = $('keyStatus');
  if (!key) {
    status.className = 'key-status bad';
    status.textContent = 'Paste a key first.';
    return;
  }
  status.className = 'key-status';
  status.textContent = 'Checking…';
  const check = await api.verifyKey(key);
  if (!check.ok) {
    status.className = 'key-status bad';
    status.textContent = 'That key was not accepted by Gemini.';
    return;
  }
  await api.setApiKey(key);
  await refreshSettings();
  status.className = 'key-status ok';
  status.textContent = 'Saved and verified.';
  $('apiKeyInput').value = '';
  toast('API key saved.');
  for (const rec of state.records) {
    if (rec.status === 'no_key' || rec.status === 'error') api.retryTranscription(rec.id);
  }
}

// theme
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  reflectThemeSeg(mode || 'system');
}
function reflectThemeSeg(mode) {
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === mode));
}

// keybind
function reflectShortcut(accel) {
  $('shortcutDisplay').textContent = formatShortcut(accel) || '—';
}
function startCapture() {
  state.capturing = true;
  $('shortcutDisplay').classList.add('capturing');
  $('shortcutDisplay').textContent = 'Press keys…';
  $('shortcutStatus').textContent = '';
  window.addEventListener('keydown', onCaptureKey, true);
}
function stopCapture() {
  state.capturing = false;
  $('shortcutDisplay').classList.remove('capturing');
  window.removeEventListener('keydown', onCaptureKey, true);
}
function keyFromEvent(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const map = { Space: 'Space', Enter: 'Return', Tab: 'Tab', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  return map[c] || null;
}
function buildAccel(e) {
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyFromEvent(e);
  if (!key || !mods.length) return null; // need a modifier + a real key
  return [...mods, key].join('+');
}
async function onCaptureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    stopCapture();
    reflectShortcut(state.settings.shortcut);
    return;
  }
  const accel = buildAccel(e);
  if (!accel) return; // still waiting for modifier + key
  stopCapture();
  const res = await api.setShortcut(accel);
  if (res.ok) {
    state.settings = res.settings;
    reflectShortcut(accel);
    $('shortcutChip').textContent = formatShortcut(accel);
    $('shortcutStatus').className = 'key-status ok';
    $('shortcutStatus').textContent = 'Shortcut updated.';
  } else {
    reflectShortcut(state.settings.shortcut);
    $('shortcutStatus').className = 'key-status bad';
    $('shortcutStatus').textContent = 'That combination is unavailable — try another.';
  }
}
async function resetShortcut() {
  const res = await api.resetShortcut();
  state.settings = res.settings;
  reflectShortcut(state.settings.shortcut);
  $('shortcutChip').textContent = formatShortcut(state.settings.shortcut);
  $('shortcutStatus').className = 'key-status ok';
  $('shortcutStatus').textContent = 'Reset to default.';
}

// ---------------------------------------------------------------- devices
//
// "Automatic" (default): use a connected headphone / external mic when present,
// otherwise the built-in mic. If the headphones drop out mid-recording we swap
// to the built-in mic and keep going. A manual pick pins one device.

let switching = false; // guards against overlapping device swaps

async function bootstrapDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('mic bootstrap failed:', err && err.name);
  }
  await enumerateInputs();
  updateDevicePill();
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
}

async function enumerateInputs() {
  const all = await navigator.mediaDevices.enumerateDevices();
  state.devices = all.filter((d) => d.kind === 'audioinput');
}

// Real, selectable inputs (excludes the 'default' / 'communications' aliases).
function realInputs() {
  return state.devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
}

function isBuiltInMic(label) {
  return /built-?in|macbook|imac|mac\s*(mini|studio|pro)/i.test(label || '');
}

// Virtual / meeting / loopback devices and iPhone-continuity mics are NOT real
// headphones — auto mode must never grab these.
const VIRTUAL_RE = /virtual|aggregate|blackhole|loopback|soundflower|vb-?audio|vb-?cable|\bcable\b|multi-output|teams|zoom|webex|google meet|\bobs\b|krisp|wavelink|background music|existential/i;
const CONTINUITY_RE = /iphone|ipad|continuity/i;

// A genuine external headphone / headset / USB mic worth auto-selecting.
function isHeadphoneMic(label) {
  return Boolean(label) && !isBuiltInMic(label) && !VIRTUAL_RE.test(label) && !CONTINUITY_RE.test(label);
}

// Most-recently-connected real headphone/headset input, if any.
function preferredExternalMic() {
  const cand = realInputs().filter((d) => isHeadphoneMic(d.label));
  return cand.length ? cand[cand.length - 1] : null;
}

// A virtual loopback INPUT (BlackHole / Loopback / Soundflower) used to capture
// the Mac's system audio — the reliable path on macOS 26.
const LOOPBACK_RE = /blackhole|loopback|soundflower|vb-?(audio|cable)/i;
function resolveSystemDeviceId() {
  const d = realInputs().find((x) => LOOPBACK_RE.test(x.label || ''));
  return d ? d.deviceId : null;
}

// The built-in mic, used when recording system audio over Bluetooth (so the
// headphones stay in hi-fi instead of dropping to call-quality).
function builtinMicDevice() {
  return realInputs().find((d) => isBuiltInMic(d.label)) || null;
}

// The concrete deviceId to actually record from, given the current mode.
function resolveDeviceId() {
  if (state.deviceMode === 'manual') {
    return realInputs().some((d) => d.deviceId === state.deviceId) ? state.deviceId : 'default';
  }
  const ext = preferredExternalMic();
  return ext ? ext.deviceId : 'default';
}

function resolvedDeviceLabel() {
  const id = resolveDeviceId();
  if (id === 'default') {
    const builtin = realInputs().find((d) => isBuiltInMic(d.label));
    if (builtin) return builtin.label;
    const def = state.devices.find((d) => d.deviceId === 'default');
    return (def && def.label && def.label.replace(/^Default\s*-\s*/i, '')) || 'Built-in microphone';
  }
  const d = realInputs().find((x) => x.deviceId === id);
  return d ? d.label : 'Microphone';
}

function updateDevicePill() {
  if (state.micLocked) return; // keep the pinned mic during a system-audio recording
  state.deviceLabel = resolvedDeviceLabel();
  const prefix = state.deviceMode === 'auto' ? 'Auto · ' : '';
  $('deviceName').textContent = prefix + state.deviceLabel;
}

// devicechange fires on plug/unplug. Update the pill, and if recording in auto
// mode, follow the change (switch to a new headphone, or off a dropped one).
async function onDeviceChange() {
  await enumerateInputs();
  updateDevicePill();
  maybeAutoSwitch();
}

// Called by a mid-recording mic loss (track 'ended') as well as devicechange.
async function maybeAutoSwitch() {
  if (switching || !state.recording || !recorder) return;
  if (state.micLocked) return; // system-audio recording pinned the mic on purpose
  if (state.deviceMode !== 'auto') return; // manual loss is handled in onLevel
  const want = resolveDeviceId();
  const activePresent =
    state.activeDeviceId === 'default' || realInputs().some((d) => d.deviceId === state.activeDeviceId);
  if (activePresent && want === state.activeDeviceId) return; // nothing to do

  switching = true;
  try {
    await recorder.swapInput(want);
    state.activeDeviceId = want;
    updateDevicePill();
    toast(activePresent ? `Switched to ${resolvedDeviceLabel()}.` : `Mic disconnected — using ${resolvedDeviceLabel()}.`);
  } catch (err) {
    console.error('[device] swap failed:', err);
    if (!activePresent) {
      toast('Microphone disconnected — recording saved.');
      stopRecording('save');
    }
  } finally {
    switching = false;
  }
}

async function handleMicLost() {
  if (!state.recording) return;
  if (state.deviceMode === 'manual') {
    toast('Microphone disconnected — recording saved.');
    return stopRecording('save');
  }
  await enumerateInputs();
  maybeAutoSwitch();
}

function openDeviceMenu() {
  const menu = $('deviceMenu');
  const pill = $('devicePill');
  const seen = new Set();
  const reals = [];
  for (const d of state.devices) {
    if (d.deviceId === 'default' || d.deviceId === 'communications' || seen.has(d.deviceId)) continue;
    if (LOOPBACK_RE.test(d.label || '')) continue; // a loopback device is for system audio, not a mic
    seen.add(d.deviceId);
    reals.push({ deviceId: d.deviceId, label: d.label || 'Microphone', external: isHeadphoneMic(d.label) });
  }
  const autoActive = state.deviceMode === 'auto';
  let html = `<button class="device-option${autoActive ? ' active' : ''}" data-id="auto">
      <span>Automatic${autoActive ? ` · ${escapeHtml(resolvedDeviceLabel())}` : ''}</span>
      ${checkSvg()}
    </button>`;
  for (const o of reals) {
    const active = !autoActive && o.deviceId === state.deviceId;
    html += `<button class="device-option${active ? ' active' : ''}" data-id="${o.deviceId}">
        <span>${escapeHtml(o.label)}${o.external ? ' 🎧' : ''}</span>
        ${checkSvg()}
      </button>`;
  }
  menu.innerHTML = html;
  menu.hidden = false;
  const r = pill.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(12, Math.min(r.left, window.innerWidth - mw - 12)) + 'px';
  menu.style.top = r.bottom + 8 + 'px';
}

function checkSvg() {
  return '<svg class="check" viewBox="0 0 24 24" width="15" height="15"><path d="M5 12l5 5 9-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function selectDevice(id) {
  if (id === 'auto') {
    state.deviceMode = 'auto';
    localStorage.setItem('misra.deviceMode', 'auto');
  } else {
    state.deviceMode = 'manual';
    state.deviceId = id;
    localStorage.setItem('misra.deviceMode', 'manual');
    localStorage.setItem('misra.deviceId', id);
  }
  updateDevicePill();
}

function closeDeviceMenu() {
  $('deviceMenu').hidden = true;
}

// ---------------------------------------------------------------- search
function onSearch() {
  state.query = $('searchInput').value.trim();
  const has = Boolean(state.query);
  $('searchClear').hidden = !has;
  $('kbdHint').hidden = has; // swap the ⌘F hint for the clear button while typing
  if (state.semantic && has) {
    scheduleSemantic();
  } else {
    state.semanticOrder = null;
    renderHistory();
  }
}
function clearSearch() {
  $('searchInput').value = '';
  state.query = '';
  state.semanticOrder = null;
  $('searchClear').hidden = true;
  $('kbdHint').hidden = false;
  renderHistory();
  $('searchInput').focus();
}

// ---------------------------------------------------------------- wiring
function wireEvents() {
  $('recordBtn').addEventListener('click', () => (state.recording ? stopRecording('save') : startRecording()));
  $('cancelBtn').addEventListener('click', () => stopRecording('cancel'));

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsBack').addEventListener('click', closeSettings);
  $('detailBack').addEventListener('click', closeDetail);
  $('keyNudge').addEventListener('click', openSettings);

  // editable recording title
  $('detailTitle').addEventListener('blur', saveTitle);
  $('detailTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      const rec = recordById(state.selectedId);
      e.target.value = (rec && rec.title) || '';
      e.target.blur();
    }
  });

  $('saveKeyBtn').addEventListener('click', saveKey);
  $('apiKeyInput').addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());
  $('modelSelect').addEventListener('change', async (e) => {
    await api.setModel(e.target.value);
    await refreshSettings();
    toast('Model updated.');
  });
  $('openFolderBtn').addEventListener('click', () => api.openRoot());
  $('studioLink').addEventListener('click', () => api.openExternal('https://aistudio.google.com/apikey'));
  $('themeSeg').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const mode = btn.dataset.theme;
    state.settings = await api.setTheme(mode);
    applyTheme(mode);
  });
  $('changeShortcutBtn').addEventListener('click', () => (state.capturing ? stopCapture() : startCapture()));
  $('resetShortcutBtn').addEventListener('click', resetShortcut);
  $('systemAudioToggle').addEventListener('change', async (e) => {
    state.settings = await api.setSystemAudio(e.target.checked);
    updateSystemAudioStatus();
    toast(e.target.checked ? 'System audio on (needs a loopback device like BlackHole).' : 'System audio off — recording mic only.');
  });
  $('userNameInput').addEventListener('change', async (e) => {
    state.settings = await api.setUserName(e.target.value);
    e.target.value = state.settings.userName;
  });

  // search
  $('searchInput').addEventListener('input', onSearch);
  $('searchClear').addEventListener('click', clearSearch);

  // filters: period chips + sort toggle
  $('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.period = chip.dataset.period;
    document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderHistory();
  });
  $('sortBtn').addEventListener('click', () => {
    state.sort = state.sort === 'new' ? 'old' : 'new';
    $('sortLabel').textContent = state.sort === 'new' ? 'Newest' : 'Oldest';
    renderHistory();
  });
  $('semanticToggle').addEventListener('click', toggleSemantic);

  // history (delegated): action buttons first, else open detail
  const groups = $('groups');
  groups.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act]');
    const entry = e.target.closest('.entry');
    if (!entry) return;
    const id = entry.dataset.id;
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === 'play') togglePlay(id);
      else if (act === 'copy') copyTranscript(id);
      else if (act === 'more') openRowMenu(id, actBtn);
      return;
    }
    openDetail(id);
  });
  groups.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const entry = e.target.closest('.entry');
    if (entry) openDetail(entry.dataset.id);
  });

  // row menu
  $('rowMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const id = $('rowMenu').dataset.id;
    const act = item.dataset.act;
    closeRowMenu();
    if (act === 'rename') startRename(id);
    else if (act === 'share') openShareSheet(id);
    else if (act === 'copy') copyTranscript(id);
    else if (act === 'export') exportTranscriptFor(id);
    else if (act === 'reveal') api.revealRecording(id);
    else if (act === 'delete') deleteRecording(id);
  });

  // view switcher (Recordings / Shared with me)
  $('viewSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setView(btn.dataset.view);
  });

  // inbox list (delegated): play inline or open the read-only detail
  const inboxGroups = $('inboxGroups');
  inboxGroups.addEventListener('click', (e) => {
    const entry = e.target.closest('.inbox-entry');
    if (!entry) return;
    const shareId = entry.dataset.share;
    if (e.target.closest('[data-act="playShared"]')) {
      e.stopPropagation();
      togglePlayShared(shareId);
      return;
    }
    openSharedDetail(shareId);
  });
  inboxGroups.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const entry = e.target.closest('.inbox-entry');
    if (entry) openSharedDetail(entry.dataset.share);
  });

  // share sheet
  $('shareBack').addEventListener('click', closeShareSheet);
  $('shareApplyBtn').addEventListener('click', applyShare);
  $('shareRemoveCloudBtn').addEventListener('click', removeFromCloud);

  // sharing settings
  $('connectBtn').addEventListener('click', connectSharing);
  $('displayNameInput').addEventListener('keydown', (e) => e.key === 'Enter' && connectSharing());
  $('signOutBtn').addEventListener('click', signOutSharing);

  // speaker chips → rename popover (delegated; legacy chips are spans, not buttons)
  $('transcriptBody').addEventListener('click', (e) => {
    const chip = e.target.closest('button.speaker-chip');
    if (!chip) return;
    e.stopPropagation();
    openSpeakerMenu(chip.dataset.speaker, chip);
  });
  $('speakerMenu').addEventListener('click', (e) => e.stopPropagation());
  $('speakerNameInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commitSpeakerRename();
    else if (e.key === 'Escape') closeSpeakerMenu();
  });
  $('speakerNameInput').addEventListener('blur', commitSpeakerRename);

  // detail actions
  $('copyBtn').addEventListener('click', () => {
    if (state.sharedDetail) copySharedTranscript(state.sharedDetail);
    else if (state.selectedId) copyTranscript(state.selectedId);
  });
  $('shareBtn').addEventListener('click', () => state.selectedId && openShareSheet(state.selectedId));
  $('exportBtn').addEventListener('click', () => state.selectedId && exportTranscriptFor(state.selectedId));
  $('retranscribeBtn').addEventListener('click', () => state.selectedId && reTranscribe(state.selectedId));
  $('revealBtn').addEventListener('click', () => state.selectedId && api.revealRecording(state.selectedId));
  $('deleteBtn').addEventListener('click', () => state.selectedId && deleteRecording(state.selectedId));

  // device picker
  $('devicePill').addEventListener('click', (e) => {
    e.stopPropagation();
    $('deviceMenu').hidden ? openDeviceMenu() : closeDeviceMenu();
  });
  $('deviceMenu').addEventListener('click', (e) => {
    const opt = e.target.closest('.device-option');
    if (!opt) return;
    selectDevice(opt.dataset.id);
    closeDeviceMenu();
  });
  document.addEventListener('click', () => {
    closeDeviceMenu();
    closeRowMenu();
    closeSpeakerMenu();
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (state.capturing) return;
    if (e.key === 'Escape') {
      if (!$('deviceMenu').hidden) return closeDeviceMenu();
      if (!$('rowMenu').hidden) return closeRowMenu();
      if (!$('speakerMenu').hidden) return closeSpeakerMenu();
      if ($('shareSheet').classList.contains('open')) return closeShareSheet();
      if ($('settings').classList.contains('open')) return closeSettings();
      if ($('detail').classList.contains('open')) return closeDetail();
    }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('searchInput').focus();
      $('searchInput').select();
      return;
    }
    if (e.code === 'Space' && !typing && !$('settings').classList.contains('open') && !$('detail').classList.contains('open')) {
      e.preventDefault();
      state.recording ? stopRecording('save') : startRecording();
    }
  });

  api.onShortcutToggle(() => (state.recording ? stopRecording('save') : startRecording()));
  api.onVolumeChanged((v) => {
    if (!v) return;
    toast(v.muted ? '🔇 Muted' : `🔊 ${Math.round((v.volume || 0) * 100)}%`);
  });
  let volumePermPrompted = false;
  api.onVolumePermission(() => {
    if (volumePermPrompted) return; // ask once per session
    volumePermPrompted = true;
    toast('To use the volume keys while recording, enable Misracorder under Accessibility.');
    api.openAccessibility();
  });
  api.onRecordingUpdated((rec) => {
    if (rec.status !== 'transcribing') delete state.progress[rec.id]; // run finished
    delete state.segments[rec.id]; // transcript changed → segments are stale
    upsertRecord(rec);
    if (rec.status === 'done') state.embeddings = null; // a new embedding may exist now
  });

  api.onTranscribeProgress(({ id, done, total }) => {
    state.progress[id] = { done, total };
    const rec = recordById(id);
    if (id === state.selectedId && rec && rec.status === 'transcribing') {
      const bodyEl = $('transcriptBody');
      bodyEl.classList.add('placeholder');
      bodyEl.textContent = transcribingLabel(id);
    }
  });

  // cloud sharing events
  api.onInboxState(({ items, unread, signedOut }) => {
    state.inbox = { items: items || [], unread: unread || 0 };
    $('inboxDot').hidden = !state.inbox.unread;
    if (signedOut && state.settings.cloudConnected) {
      refreshSettings().then(() => {
        updateSharingSection();
        renderHistory();
      });
      toast('Sharing session expired — reconnect in Settings.');
    }
    if (state.view === 'inbox') renderInbox();
  });
  api.onInboxOpen(() => setView('inbox'));
  api.onShareProgress(({ id, phase }) => {
    if (state.shareFor === id) $('shareProgress').textContent = SHARE_PHASES[phase] || '';
  });
}

// ---------------------------------------------------------------- init
async function init() {
  setupCanvas();
  wirePlayer();
  wireEvents();

  await refreshSettings();
  applyTheme(state.settings.theme);
  $('shortcutChip').textContent = formatShortcut(state.settings.shortcut);
  updateSemanticToggle();

  state.records = await api.listRecordings();
  renderHistory();

  // Seed the inbox from main's last poll (it also pushes inbox:state updates).
  api
    .inboxList()
    .then(({ items, unread }) => {
      state.inbox = { items: items || [], unread: unread || 0 };
      $('inboxDot').hidden = !state.inbox.unread;
      if (state.view === 'inbox') renderInbox();
    })
    .catch(() => {});

  await bootstrapDevices();
}

init();
