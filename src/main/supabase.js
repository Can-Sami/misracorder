'use strict';

// Cloud sharing: Supabase client + share/inbox logic (raw fetch, main process
// only — the renderer stays offline and talks to this module over IPC).
//
// • redeemInvite      — invite code + display name → persistent identity
// • shareCreate       — upload (AAC via afconvert) + share to users / web link
// • revoke*/deleteCloud — un-share; local files stay the source of truth
// • inbox             — poll for shares to me, notify + badge, cached playback
//
// Auth: the refresh token is persisted encrypted (config.cloudSession); access
// tokens live only in memory and refresh single-flight. All PostgREST access
// rides the user's JWT under RLS — no privileged key ships with the app.

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, Notification } = require('electron');
const config = require('./config');
const storage = require('./storage');

const execFileP = promisify(execFile);

// --- deployment constants ---------------------------------------------------
// Baked in at ship time (see README "Sharing setup"); env vars override for dev.
const SUPABASE_URL = process.env.MISRA_SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co';
const ANON_KEY = process.env.MISRA_SUPABASE_ANON_KEY || 'YOUR-ANON-KEY';
const WORKER_BASE = process.env.MISRA_SHARE_WORKER || 'https://YOUR-WORKER.workers.dev';

const WAV_FALLBACK_MAX = 45 * 1024 * 1024; // storage free-tier object cap is 50MB
const POLL_MS = 60_000;
const PROFILE_CACHE_MS = 5 * 60_000;

function isConfigured() {
  return !SUPABASE_URL.includes('YOUR-PROJECT');
}

// --- module state -------------------------------------------------------------

let send = () => {}; // main → renderer event bridge, injected by init()
let focusApp = () => {}; // bring the window forward (notification clicks)
let session = null; // { accessToken, refreshToken, expiresAt (epoch sec), userId, displayName }
let refreshPromise = null;
let pollTimer = null;
let pollGen = 0; // bumped on sign-out so an in-flight poll can't resurrect state
let profilesCache = { at: 0, list: [] };
let lastInbox = { items: [], unread: 0 };

function init({ send: sendFn, focus }) {
  send = sendFn;
  if (focus) focusApp = focus;
  const saved = config.getCloudSession();
  if (saved) {
    session = { accessToken: null, expiresAt: 0, ...saved };
    startPolling();
  }
}

function status() {
  return session
    ? { connected: true, displayName: session.displayName, userId: session.userId }
    : { connected: false, configured: isConfigured() };
}

async function signOut() {
  session = null;
  pollGen++;
  stopPolling();
  lastInbox = { items: [], unread: 0 };
  app.setBadgeCount(0);
  send('inbox:state', { items: [], unread: 0, signedOut: true });
  await config.setCloudSession(null);
  return { ok: true };
}

// --- session / fetch ----------------------------------------------------------

function offline(err) {
  return err && (err.name === 'TypeError' || /fetch failed|network/i.test(err.message || ''));
}

async function persistSession(tokens) {
  session = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at || Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
    userId: tokens.user_id || session?.userId,
    displayName: tokens.display_name || session?.displayName,
  };
  // Persist the rotated refresh token BEFORE anyone can use the old one again.
  await config.setCloudSession({
    refreshToken: session.refreshToken,
    userId: session.userId,
    displayName: session.displayName,
  });
}

async function refreshSession() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Refresh token revoked/expired — sign the user out; they reconnect
      // with their invite code (after allow_rebind is flipped).
      await signOut();
      throw new Error('signed_out');
    }
    throw new Error(`refresh failed: HTTP ${res.status}`);
  }
  await persistSession(await res.json());
}

async function ensureSession() {
  if (!isConfigured()) throw new Error('not_configured');
  if (!session) throw new Error('signed_out');
  if (session.accessToken && session.expiresAt - 60 > Date.now() / 1000) return;
  if (!refreshPromise) {
    refreshPromise = refreshSession().finally(() => {
      refreshPromise = null;
    });
  }
  await refreshPromise;
}

// Authenticated fetch against Supabase (PostgREST / Storage / Functions).
// Retries once through a refresh on 401.
async function sbFetch(pathname, { method = 'GET', headers = {}, body, raw = false } = {}) {
  await ensureSession();
  const doFetch = () =>
    fetch(`${SUPABASE_URL}${pathname}`, {
      method,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${session.accessToken}`,
        ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshSession();
    res = await doFetch();
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''} (${method} ${pathname.split('?')[0]})`);
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Public wrapper: turn thrown errors into { ok:false, reason } for the renderer.
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (offline(err)) return { ok: false, reason: 'offline' };
    const known = ['not_configured', 'signed_out', 'too_large', 'convert_failed'];
    const reason = known.includes(err.message) ? err.message : 'error';
    if (reason === 'error') console.error('[cloud]', err.message);
    return { ok: false, reason, detail: err.message };
  }
}

// --- invite redemption --------------------------------------------------------

async function redeemInvite(code, displayName) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-invite`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error || `http_${res.status}` };
    await persistSession(data);
    startPolling();
    return { ok: true, displayName: session.displayName };
  } catch (err) {
    return { ok: false, reason: offline(err) ? 'offline' : 'error', detail: err.message };
  }
}

// --- roster ---------------------------------------------------------------------

async function listProfiles() {
  return guarded(async () => {
    if (Date.now() - profilesCache.at < PROFILE_CACHE_MS) return { ok: true, profiles: profilesCache.list };
    const rows = await sbFetch('/rest/v1/profiles?select=id,display_name&order=display_name.asc');
    profilesCache = {
      at: Date.now(),
      list: rows.filter((p) => p.id !== session.userId).map((p) => ({ id: p.id, displayName: p.display_name })),
    };
    return { ok: true, profiles: profilesCache.list };
  });
}

// --- upload ---------------------------------------------------------------------

// The share payload carries the transcript in both shapes: structured segments
// (with per-recording speaker renames already resolved into plain labels) when
// the recording is diarized, and always the flattened text as a fallback.
async function buildTranscriptPayload(record) {
  const data = await storage.readSegments(record.id);
  if (!data) return { format: 'plain', text: record.transcript || '' };
  const byId = new Map(data.speakers.map((s) => [s.id, s]));
  return {
    format: 'segments',
    text: record.transcript || '',
    language: data.language || '',
    speakers: data.speakers.map((s) => ({ label: s.label, gender: s.gender, isUser: Boolean(s.isUser) })),
    segments: data.segments.map((g) => ({
      speaker: byId.get(g.speaker)?.label || 'Speaker',
      text: g.text,
      ...(g.start !== undefined ? { start: g.start, end: g.end } : {}),
    })),
  };
}

// WAV → AAC .m4a with the macOS built-in converter (no bundled ffmpeg): a 1h
// stereo recording drops from ~230MB to ~20MB. Falls back to raw WAV only for
// small files if afconvert is unavailable/fails.
async function convertForUpload(record, onPhase) {
  const wavPath = storage.absAudioPath(record);
  const tmp = path.join(os.tmpdir(), `misra-${record.id}.m4a`);
  onPhase('converting');
  for (const bitrate of ['48000', '64000']) {
    try {
      await execFileP('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', bitrate, wavPath, tmp]);
      const buffer = await fsp.readFile(tmp);
      await fsp.unlink(tmp).catch(() => {});
      return { buffer, format: 'm4a', contentType: 'audio/mp4' };
    } catch (err) {
      console.warn(`[cloud] afconvert @${bitrate} failed:`, err.message);
    }
  }
  const wav = await fsp.readFile(wavPath);
  if (wav.length > WAV_FALLBACK_MAX) throw new Error('too_large');
  return { buffer: wav, format: 'wav', contentType: 'audio/wav' };
}

async function uploadRecording(record, onPhase) {
  const { buffer, format, contentType } = await convertForUpload(record, onPhase);
  const audioPath = `${session.userId}/${record.id}.${format}`; // deterministic → re-uploads overwrite

  onPhase('uploading');
  let lastErr = null;
  for (const backoff of [0, 1000, 4000]) {
    if (backoff) await new Promise((r) => setTimeout(r, backoff));
    try {
      await sbFetch(`/storage/v1/object/audio/${audioPath}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: buffer,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;

  onPhase('saving');
  const row = {
    owner_id: session.userId,
    client_id: record.id,
    title: record.title || '',
    duration_sec: record.durationSec || 0,
    created_at_local: record.createdAt || null,
    updated_at: new Date().toISOString(),
    audio_path: audioPath,
    audio_format: format,
    audio_bytes: buffer.length,
    channels: record.channels || 1,
    transcript: await buildTranscriptPayload(record),
  };
  const [saved] = await sbFetch('/rest/v1/recordings?on_conflict=owner_id,client_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: [row],
  });
  await storage.setCloudInfo(record.id, {
    recordingId: saved.id,
    audioPath,
    audioFormat: format,
    uploadedAt: new Date().toISOString(),
  });
  return saved.id;
}

// --- share status / create / revoke ------------------------------------------

async function shareStatus(id) {
  return guarded(async () => {
    const record = await storage.getRecord(id);
    if (!record) throw new Error('error');
    if (!record.cloud) return { ok: true, uploaded: false, sharedWith: [], link: null };
    const cloudId = record.cloud.recordingId;
    const [shares, links] = await Promise.all([
      sbFetch(
        `/rest/v1/shares?select=recipient_id,revoked_at,recipient:profiles!shares_recipient_id_fkey(display_name)&recording_id=eq.${cloudId}`
      ),
      sbFetch(`/rest/v1/link_shares?select=slug,revoked_at&recording_id=eq.${cloudId}&order=created_at.desc`),
    ]);
    const activeLink = links.find((l) => !l.revoked_at);
    return {
      ok: true,
      uploaded: true,
      sharedWith: shares
        .filter((s) => !s.revoked_at)
        .map((s) => ({ id: s.recipient_id, displayName: s.recipient?.display_name || '?' })),
      link: activeLink ? { url: `${WORKER_BASE}/s/${activeLink.slug}`, slug: activeLink.slug } : null,
    };
  });
}

async function shareCreate({ id, recipientIds = [], makeLink = false }) {
  return guarded(async () => {
    const record = await storage.getRecord(id);
    if (!record) throw new Error('error');
    const onPhase = (phase) => send('share:progress', { id, phase });

    await ensureSession();
    let cloudId = record.cloud?.recordingId;
    if (!cloudId) {
      cloudId = await uploadRecording(record, onPhase);
    } else {
      // Refresh title + transcript so post-share renames/re-transcribes are reflected.
      onPhase('saving');
      await sbFetch(`/rest/v1/recordings?id=eq.${cloudId}`, {
        method: 'PATCH',
        body: {
          title: record.title || '',
          transcript: await buildTranscriptPayload(record),
          updated_at: new Date().toISOString(),
        },
      });
    }

    if (recipientIds.length) {
      // Insert new shares; then revive any previously revoked ones with a
      // plain PATCH (column grants only allow updating seen_at/revoked_at).
      await sbFetch('/rest/v1/shares?on_conflict=recording_id,recipient_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: recipientIds.map((rid) => ({
          recording_id: cloudId,
          owner_id: session.userId,
          recipient_id: rid,
        })),
      });
      await sbFetch(
        `/rest/v1/shares?recording_id=eq.${cloudId}&recipient_id=in.(${recipientIds.join(',')})&revoked_at=not.is.null`,
        { method: 'PATCH', body: { revoked_at: null, seen_at: null } }
      );
    }

    if (makeLink) {
      const existing = await sbFetch(
        `/rest/v1/link_shares?select=slug&recording_id=eq.${cloudId}&revoked_at=is.null&limit=1`
      );
      if (!existing.length) {
        const slug = crypto.randomBytes(16).toString('base64url');
        await sbFetch('/rest/v1/link_shares', {
          method: 'POST',
          body: { recording_id: cloudId, owner_id: session.userId, slug },
        });
      }
    }

    send('share:progress', { id, phase: 'done' });
    return shareStatus(id);
  });
}

async function revokeShare(id, recipientId) {
  return guarded(async () => {
    const record = await storage.getRecord(id);
    if (!record?.cloud) throw new Error('error');
    await sbFetch(
      `/rest/v1/shares?recording_id=eq.${record.cloud.recordingId}&recipient_id=eq.${recipientId}`,
      { method: 'PATCH', body: { revoked_at: new Date().toISOString() } }
    );
    return shareStatus(id);
  });
}

async function revokeLink(id) {
  return guarded(async () => {
    const record = await storage.getRecord(id);
    if (!record?.cloud) throw new Error('error');
    await sbFetch(`/rest/v1/link_shares?recording_id=eq.${record.cloud.recordingId}&revoked_at=is.null`, {
      method: 'PATCH',
      body: { revoked_at: new Date().toISOString() },
    });
    return shareStatus(id);
  });
}

// Remove the cloud copy entirely: rows cascade (shares + links) and the audio
// object is deleted. The local recording is untouched.
async function deleteCloud(id) {
  return guarded(async () => {
    const record = await storage.getRecord(id);
    if (!record?.cloud) return { ok: true };
    const { recordingId, audioPath } = record.cloud;
    await sbFetch(`/rest/v1/recordings?id=eq.${recordingId}`, { method: 'DELETE' });
    await sbFetch(`/storage/v1/object/audio/${audioPath}`, { method: 'DELETE' }).catch(() => {});
    await storage.clearCloudInfo(id);
    return { ok: true };
  });
}

// --- inbox ("Shared with me") ---------------------------------------------------

function cacheDir() {
  return path.join(app.getPath('userData'), 'SharedCache');
}

async function fetchInbox() {
  const rows = await sbFetch(
    '/rest/v1/shares?select=id,created_at,seen_at,' +
      'recording:recordings(id,title,duration_sec,created_at_local,audio_format,audio_path,transcript,' +
      'owner:profiles!recordings_owner_id_fkey(display_name))' +
      `&recipient_id=eq.${session.userId}&revoked_at=is.null&order=created_at.desc`
  );
  return rows
    .filter((r) => r.recording)
    .map((r) => ({
      shareId: r.id,
      createdAt: r.created_at,
      seen: Boolean(r.seen_at),
      recordingId: r.recording.id,
      title: r.recording.title,
      durationSec: Number(r.recording.duration_sec) || 0,
      recordedAt: r.recording.created_at_local,
      audioFormat: r.recording.audio_format,
      from: r.recording.owner?.display_name || '?',
      transcript: r.recording.transcript || { format: 'plain', text: '' },
    }));
}

async function poll() {
  if (!session) return;
  const gen = pollGen;
  try {
    const items = await fetchInbox();
    if (gen !== pollGen || !session) return; // signed out while this poll was in flight
    const unread = items.filter((i) => !i.seen).length;

    // Notify once per share, across restarts: anything newer than the high-water mark.
    const lastNotified = config.getShareLastNotifiedAt() || '1970-01-01T00:00:00Z';
    const fresh = items.filter((i) => i.createdAt > lastNotified);
    if (fresh.length) {
      await config.setShareLastNotifiedAt(fresh[0].createdAt);
      if (Notification.isSupported()) {
        for (const item of fresh.slice(0, 3)) {
          const n = new Notification({
            title: 'New shared recording',
            body: `“${item.title || 'Untitled'}” from ${item.from}`,
          });
          n.on('click', () => {
            focusApp();
            send('inbox:open', {});
          });
          n.show();
        }
      }
    }

    // Evict cached audio for shares that disappeared (revoked/deleted).
    const live = new Set(items.map((i) => i.recordingId));
    for (const f of await fsp.readdir(cacheDir()).catch(() => [])) {
      if (!live.has(f.replace(/\.(m4a|wav)$/, ''))) await fsp.unlink(path.join(cacheDir(), f)).catch(() => {});
    }

    lastInbox = { items, unread };
    app.setBadgeCount(unread);
    send('inbox:state', { items, unread });
  } catch (err) {
    if (!offline(err) && err.message !== 'signed_out') console.warn('[cloud] poll failed:', err.message);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, POLL_MS);
  poll();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// An extra poll on focus/resume so pings land promptly when the app wakes.
function pollSoon() {
  if (session) poll();
}

function listInbox() {
  return { ok: true, ...lastInbox };
}

async function markSeen(shareId) {
  return guarded(async () => {
    await sbFetch(`/rest/v1/shares?id=eq.${shareId}`, {
      method: 'PATCH',
      body: { seen_at: new Date().toISOString() },
    });
    const item = lastInbox.items.find((i) => i.shareId === shareId);
    if (item && !item.seen) {
      item.seen = true;
      lastInbox.unread = lastInbox.items.filter((i) => !i.seen).length;
      app.setBadgeCount(lastInbox.unread);
      send('inbox:state', lastInbox);
    }
    return { ok: true };
  });
}

// Download a shared recording's audio into the local cache (RLS-checked) and
// hand back a file path — the renderer plays it like any local recording.
async function playShared(shareId) {
  return guarded(async () => {
    const item = lastInbox.items.find((i) => i.shareId === shareId);
    if (!item) throw new Error('error');
    const file = path.join(cacheDir(), `${item.recordingId}.${item.audioFormat}`);
    if (
      await fsp
        .access(file)
        .then(() => true)
        .catch(() => false)
    ) {
      return { ok: true, localPath: file };
    }
    send('share:progress', { id: item.shareId, phase: 'downloading' });
    const rows = await sbFetch(`/rest/v1/recordings?select=audio_path&id=eq.${item.recordingId}`);
    if (!rows.length) throw new Error('error');
    const res = await sbFetch(`/storage/v1/object/authenticated/audio/${rows[0].audio_path}`, { raw: true });
    const buffer = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(cacheDir(), { recursive: true });
    await fsp.writeFile(file, buffer);
    send('share:progress', { id: item.shareId, phase: 'done' });
    return { ok: true, localPath: file };
  });
}

module.exports = {
  init,
  status,
  isConfigured,
  redeemInvite,
  signOut,
  listProfiles,
  shareStatus,
  shareCreate,
  revokeShare,
  revokeLink,
  deleteCloud,
  listInbox,
  markSeen,
  playShared,
  pollSoon,
  stopPolling,
};
