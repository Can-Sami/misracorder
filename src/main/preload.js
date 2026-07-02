'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The single, audited surface the renderer is allowed to touch. No Node, no fs.
contextBridge.exposeInMainWorld('api', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  verifyKey: (key) => ipcRenderer.invoke('settings:verifyKey', key),
  setModel: (model) => ipcRenderer.invoke('settings:setModel', model),
  setTheme: (theme) => ipcRenderer.invoke('settings:setTheme', theme),
  setShortcut: (accel) => ipcRenderer.invoke('settings:setShortcut', accel),
  resetShortcut: () => ipcRenderer.invoke('settings:resetShortcut'),
  setSystemAudio: (on) => ipcRenderer.invoke('settings:setSystemAudio', on),
  setUserName: (name) => ipcRenderer.invoke('settings:setUserName', name),

  // system-audio routing (auto Multi-Output Device via the bundled helper)
  systemAudioBegin: () => ipcRenderer.invoke('systemAudio:begin'),
  systemAudioEnd: () => ipcRenderer.invoke('systemAudio:end'),
  systemAudioCheck: () => ipcRenderer.invoke('systemAudio:check'),
  openAccessibility: () => ipcRenderer.invoke('app:openAccessibility'),

  // system-audio source name (for speaker labels) + semantic search
  audioSourceName: () => ipcRenderer.invoke('audio:sourceName'),
  embedQuery: (text) => ipcRenderer.invoke('search:embedQuery', text),
  getEmbeddings: () => ipcRenderer.invoke('recordings:embeddings'),
  backfillEmbeddings: () => ipcRenderer.invoke('search:backfill'),

  // microphone access (macOS TCC)
  ensureMicAccess: () => ipcRenderer.invoke('mic:ensureAccess'),
  openMicSettings: () => ipcRenderer.invoke('mic:openSettings'),

  // recordings
  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  getTranscript: (id) => ipcRenderer.invoke('recordings:transcript', id),
  getSegments: (id) => ipcRenderer.invoke('recordings:segments', id),
  renameSpeaker: (id, speakerId, label) => ipcRenderer.invoke('recordings:renameSpeaker', id, speakerId, label),
  setTitle: (id, title) => ipcRenderer.invoke('recordings:setTitle', id, title),
  deleteRecording: (id, alsoCloud) => ipcRenderer.invoke('recordings:delete', id, alsoCloud),
  revealRecording: (id) => ipcRenderer.invoke('recordings:reveal', id),
  exportTranscript: (id) => ipcRenderer.invoke('recordings:export', id),
  getAudioPath: (id) => ipcRenderer.invoke('recordings:audioPath', id),
  openRoot: () => ipcRenderer.invoke('app:openRoot'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // save a freshly captured WAV (ArrayBuffer) + metadata; transcription starts in main
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
  retryTranscription: (id) => ipcRenderer.invoke('recording:retry', id),

  // cloud sharing
  cloudRedeem: (code, displayName) => ipcRenderer.invoke('cloud:redeem', code, displayName),
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudSignOut: () => ipcRenderer.invoke('cloud:signOut'),
  shareProfiles: () => ipcRenderer.invoke('share:profiles'),
  shareStatus: (id) => ipcRenderer.invoke('share:status', id),
  shareCreate: (opts) => ipcRenderer.invoke('share:create', opts),
  shareRevokeUser: (id, recipientId) => ipcRenderer.invoke('share:revokeUser', id, recipientId),
  shareRevokeLink: (id) => ipcRenderer.invoke('share:revokeLink', id),
  shareDeleteCloud: (id) => ipcRenderer.invoke('share:deleteCloud', id),
  inboxList: () => ipcRenderer.invoke('inbox:list'),
  inboxMarkSeen: (shareId) => ipcRenderer.invoke('inbox:markSeen', shareId),
  inboxPlay: (shareId) => ipcRenderer.invoke('inbox:play', shareId),

  // shortcut label for the UI chip
  getShortcut: () => ipcRenderer.invoke('app:shortcut'),

  // clipboard (main-process — reliable regardless of window focus)
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),

  // auto-update
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // events from main → renderer
  onRecordingUpdated: (cb) => {
    const handler = (_e, record) => cb(record);
    ipcRenderer.on('recording:updated', handler);
    return () => ipcRenderer.removeListener('recording:updated', handler);
  },
  onTranscribeProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:progress', handler);
    return () => ipcRenderer.removeListener('recording:progress', handler);
  },
  onShortcutToggle: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('shortcut:toggle', handler);
    return () => ipcRenderer.removeListener('shortcut:toggle', handler);
  },
  onVolumeChanged: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('volume:changed', handler);
    return () => ipcRenderer.removeListener('volume:changed', handler);
  },
  onVolumePermission: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('volume:permission', handler);
    return () => ipcRenderer.removeListener('volume:permission', handler);
  },
  onInboxState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('inbox:state', handler);
    return () => ipcRenderer.removeListener('inbox:state', handler);
  },
  onInboxOpen: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('inbox:open', handler);
    return () => ipcRenderer.removeListener('inbox:open', handler);
  },
  onShareProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('share:progress', handler);
    return () => ipcRenderer.removeListener('share:progress', handler);
  },
  onUpdateReady: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:ready', handler);
    return () => ipcRenderer.removeListener('update:ready', handler);
  },
});
