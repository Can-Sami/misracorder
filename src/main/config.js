'use strict';

// App configuration: the Gemini API key (encrypted at rest), the model, and where
// recordings are stored. Persisted to <userData>/config.json. The renderer never
// sees the key — only the main process reads it to call Gemini.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_MODEL = 'gemini-3.5-flash';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+R';

let configPath = null;
let state = {
  apiKeyEnc: null, // base64 of safeStorage-encrypted key, or { plain } fallback
  model: DEFAULT_MODEL,
  rootDir: null, // null → storage default (~/Documents/Misracorder)
  theme: 'system', // 'system' | 'light' | 'dark'
  shortcut: DEFAULT_SHORTCUT, // global record toggle accelerator
  systemAudio: true, // also capture the Mac's audio output (mixed with the mic)
  userName: 'Me', // speaker label for the microphone (your voice)
  pendingOutputRestore: null, // output device UID to restore if we crash mid-recording
  cloudSession: null, // { refreshEnc|refreshPlain, userId, displayName } — sharing identity
  shareLastNotifiedAt: null, // newest share creation time we've already notified about
};

function init() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
  } catch {
    /* first run — defaults */
  }
}

async function persist() {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(state, null, 2), 'utf8');
}

// --- API key --------------------------------------------------------------

function setApiKey(plain) {
  const key = (plain || '').trim();
  if (!key) {
    state.apiKeyEnc = null;
    return persist();
  }
  if (safeStorage.isEncryptionAvailable()) {
    state.apiKeyEnc = { enc: safeStorage.encryptString(key).toString('base64') };
  } else {
    // Encryption unavailable (rare on macOS) — store as-is so the app still works.
    state.apiKeyEnc = { plain: key };
  }
  return persist();
}

function getApiKey() {
  // A user-entered key wins; otherwise fall back to the environment (dev convenience).
  if (state.apiKeyEnc) {
    if (state.apiKeyEnc.plain) return state.apiKeyEnc.plain;
    if (state.apiKeyEnc.enc) {
      try {
        return safeStorage.decryptString(Buffer.from(state.apiKeyEnc.enc, 'base64'));
      } catch (err) {
        console.error('[config] could not decrypt API key:', err.message);
      }
    }
  }
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function hasApiKey() {
  return Boolean(getApiKey());
}

// Where the key currently comes from, for honest UI ("using key from environment").
function apiKeySource() {
  if (state.apiKeyEnc) return 'stored';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'env';
  return 'none';
}

// --- model & misc ---------------------------------------------------------

function getModel() {
  return state.model || DEFAULT_MODEL;
}

function setModel(model) {
  state.model = (model || '').trim() || DEFAULT_MODEL;
  return persist();
}

function getTheme() {
  return state.theme || 'system';
}

function setTheme(theme) {
  state.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  return persist();
}

function getShortcut() {
  return state.shortcut || DEFAULT_SHORTCUT;
}

function setShortcut(accel) {
  state.shortcut = (accel || '').trim() || DEFAULT_SHORTCUT;
  return persist();
}

function getSystemAudio() {
  return state.systemAudio !== false;
}

function setSystemAudio(on) {
  state.systemAudio = Boolean(on);
  return persist();
}

function getUserName() {
  return (state.userName || 'Me').trim() || 'Me';
}

function setUserName(name) {
  state.userName = (name || '').trim().slice(0, 40) || 'Me';
  return persist();
}

// --- cloud sharing session --------------------------------------------------
// The Supabase refresh token is at-rest-encrypted exactly like the Gemini key;
// the renderer only ever learns "connected as <name>".

function setCloudSession(sessionInfo) {
  if (!sessionInfo) {
    state.cloudSession = null;
    return persist();
  }
  const { refreshToken, userId, displayName } = sessionInfo;
  const entry = { userId, displayName };
  if (safeStorage.isEncryptionAvailable()) {
    entry.refreshEnc = safeStorage.encryptString(refreshToken).toString('base64');
  } else {
    entry.refreshPlain = refreshToken;
  }
  state.cloudSession = entry;
  return persist();
}

function getCloudSession() {
  const s = state.cloudSession;
  if (!s) return null;
  let refreshToken = s.refreshPlain || null;
  if (!refreshToken && s.refreshEnc) {
    try {
      refreshToken = safeStorage.decryptString(Buffer.from(s.refreshEnc, 'base64'));
    } catch (err) {
      console.error('[config] could not decrypt cloud session:', err.message);
      return null;
    }
  }
  if (!refreshToken) return null;
  return { refreshToken, userId: s.userId, displayName: s.displayName };
}

function getShareLastNotifiedAt() {
  return state.shareLastNotifiedAt || null;
}

function setShareLastNotifiedAt(iso) {
  state.shareLastNotifiedAt = iso || null;
  return persist();
}

// Internal: the real output device to restore after a system-audio recording.
// Persisted so we can recover if the app is force-quit while routing is active.
function getPendingOutputRestore() {
  return state.pendingOutputRestore || null;
}

function setPendingOutputRestore(uid) {
  state.pendingOutputRestore = uid || null;
  return persist();
}

function getRootDir() {
  return state.rootDir || null;
}

function setRootDir(dir) {
  state.rootDir = dir || null;
  return persist();
}

// A redacted snapshot safe to hand to the renderer.
function publicSettings() {
  return {
    hasApiKey: hasApiKey(),
    apiKeySource: apiKeySource(),
    model: getModel(),
    rootDir: getRootDir(),
    theme: getTheme(),
    shortcut: getShortcut(),
    systemAudio: getSystemAudio(),
    userName: getUserName(),
    cloudConnected: Boolean(state.cloudSession),
    cloudDisplayName: state.cloudSession ? state.cloudSession.displayName : null,
  };
}

module.exports = {
  init,
  setApiKey,
  getApiKey,
  hasApiKey,
  apiKeySource,
  getModel,
  setModel,
  getTheme,
  setTheme,
  getShortcut,
  setShortcut,
  getSystemAudio,
  setSystemAudio,
  getUserName,
  setUserName,
  setCloudSession,
  getCloudSession,
  getShareLastNotifiedAt,
  setShareLastNotifiedAt,
  getPendingOutputRestore,
  setPendingOutputRestore,
  getRootDir,
  setRootDir,
  DEFAULT_SHORTCUT,
  publicSettings,
  DEFAULT_MODEL,
};
