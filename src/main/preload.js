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
  deleteRecording: (id) => ipcRenderer.invoke('recordings:delete', id),
  revealRecording: (id) => ipcRenderer.invoke('recordings:reveal', id),
  exportTranscript: (id) => ipcRenderer.invoke('recordings:export', id),
  getAudioPath: (id) => ipcRenderer.invoke('recordings:audioPath', id),
  openRoot: () => ipcRenderer.invoke('app:openRoot'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // save a freshly captured WAV (ArrayBuffer) + metadata; transcription starts in main
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
  retryTranscription: (id) => ipcRenderer.invoke('recording:retry', id),

  // shortcut label for the UI chip
  getShortcut: () => ipcRenderer.invoke('app:shortcut'),

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
});
