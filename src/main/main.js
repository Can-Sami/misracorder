'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  systemPreferences,
  globalShortcut,
  shell,
  nativeTheme,
  dialog,
  desktopCapturer,
  clipboard,
} = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const { execFile, spawn } = require('child_process');

const config = require('./config');
const storage = require('./storage');
const gemini = require('./gemini');
const wavUtil = require('./wav');
const cloud = require('./supabase');

let lastActiveApp = null; // app the user was in when they hit the global shortcut

// Best-effort name of the macOS app in front (for labeling system audio).
function getFrontmostApp() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(null);
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to name of first application process whose frontmost is true'],
      { timeout: 1500 },
      (err, stdout) => resolve(err ? null : (stdout || '').trim() || null)
    );
  });
}

// Terminals, editors, and system UI aren't "the other side of a call" — if one of
// these is frontmost, fall back to "System Sound" rather than mislabeling.
const NOT_A_CALL_APP =
  /^(electron|misracorder|terminal|iterm|cmux|tmux|warp|alacritty|kitty|ghostty|hyper|wezterm|code|cursor|vscode|finder|system settings|system preferences|windowserver|loginwindow|spotlight|control cent|dock|notification)/i;
function isSelfApp(name) {
  return !name || NOT_A_CALL_APP.test(name.trim());
}

// --- system-audio routing helper (bundled CoreAudio CLI) ------------------
// Builds/destroys a Multi-Output Device ("current output + BlackHole") so the
// recorder can capture system audio, and always restores the user's output.

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'audio-helper')
    : path.join(__dirname, '..', '..', 'resources', 'audio-helper');
}

function runHelper(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(helperPath(), args, { timeout }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try {
        resolve(JSON.parse((stdout || '').trim() || '{}'));
      } catch {
        resolve({ ok: false, error: 'bad-helper-output' });
      }
    });
  });
}

// The real output device the user is listening through during a system-audio
// recording (a Multi-Output Device has no volume control of its own, so we drive
// this device directly when the hardware volume keys are pressed).
let volumeDeviceUID = null;
let volumeListener = null; // long-running helper that taps the media keys

function startVolumeListener(deviceUID) {
  stopVolumeListener();
  if (!deviceUID) return;
  let child;
  try {
    child = spawn(helperPath(), ['listen', deviceUID]);
  } catch {
    return;
  }
  volumeListener = child;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error === 'no-permission') send('volume:permission');
      else if (typeof msg.volume === 'number' || typeof msg.muted === 'boolean') {
        send('volume:changed', { volume: msg.volume, muted: msg.muted });
      }
    }
  });
  child.on('error', () => {});
}

function stopVolumeListener() {
  if (volumeListener) {
    try {
      volumeListener.kill();
    } catch {
      /* already gone */
    }
    volumeListener = null;
  }
}

const isDev = process.argv.includes('--dev');
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const themeArg = process.argv.find((a) => a.startsWith('--theme='));

let mainWindow = null;
let registeredShortcut = null; // the accelerator currently held by globalShortcut
// Track in-flight transcriptions so we can cancel and avoid duplicates.
const inFlight = new Map(); // id -> AbortController

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- window ---------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 600,
    minHeight: 560,
    titleBarStyle: 'hiddenInset', // keep native traffic lights, lose the title bar
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1014' : '#f6f7f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Self-capture for headless visual verification (no Screen Recording permission needed).
  if (shotArg) {
    const out = shotArg.split('=')[1];
    const openArg = process.argv.find((a) => a.startsWith('--open='));
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (openArg) {
            const id = openArg.split('=')[1];
            await mainWindow.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
            await new Promise((r) => setTimeout(r, 450));
          }
          const evalArg = process.argv.find((a) => a.startsWith('--eval='));
          if (evalArg) {
            const js = Buffer.from(evalArg.split('=')[1], 'base64').toString('utf8');
            await mainWindow.webContents.executeJavaScript(js);
            await new Promise((r) => setTimeout(r, 500));
          }
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(out, img.toPNG());
          console.log('[shot] wrote', out);
        } catch (err) {
          console.error('[shot] failed', err.message);
        }
      }, 1400);
    });
  }

  // Surface renderer console + crashes on the main stdout (useful for diagnostics).
  mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
    const tag = ['log', 'warn', 'error'][level] || 'log';
    console.log(`[renderer:${tag}] ${message}${src ? ` (${src}:${line})` : ''}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason);
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload error]', p, err && err.message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- permissions ----------------------------------------------------------

function wirePermissions() {
  // Electron's session denies getUserMedia by default — independent of OS TCC.
  // clipboard-sanitized-write backs navigator.clipboard.writeText (copy buttons).
  const ALLOWED = ['media', 'microphone', 'audioCapture', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(ALLOWED.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOWED.includes(permission));

  // System-audio capture: when the renderer calls getDisplayMedia(), grant a
  // screen source plus loopback (the Mac's audio output). The renderer keeps the
  // audio track and discards the video. Requires macOS 13+ and the Screen
  // Recording permission (macOS prompts on first use).
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources && sources[0]) callback({ video: sources[0], audio: 'loopback' });
          else callback({}); // deny → renderer falls back to mic-only
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

async function ensureMicAccess() {
  if (process.platform !== 'darwin') return { status: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { status };
  if (status === 'not-determined') {
    const ok = await systemPreferences.askForMediaAccess('microphone');
    return { status: ok ? 'granted' : 'denied' };
  }
  return { status }; // 'denied' | 'restricted' — caller deep-links to settings
}

// --- transcription orchestration -----------------------------------------

async function runTranscription(record) {
  const apiKey = config.getApiKey();
  if (!apiKey) {
    const updated = await storage.setError(record.id, 'Add a Gemini API key in Settings to transcribe.');
    send('recording:updated', { ...updated, status: 'no_key' });
    return;
  }

  const controller = new AbortController();
  inFlight.set(record.id, controller);
  const model = record.model || config.getModel();
  try {
    const filePath = storage.absAudioPath(record);
    const buffer = await fsp.readFile(filePath);
    const micName = record.micName || config.getUserName();
    const sysName = record.sysName || 'System Sound';
    const onProgress = (done, total) => {
      if (total > 1) send('recording:progress', { id: record.id, done, total });
    };

    // Diarized pipeline: structured segments with per-voice speaker labels.
    // Both stereo (L=mic, R=system) and mono recordings go through the same
    // windowed engine — long audio is cut into short windows first, since
    // one-shot transcription of many-minute audio degrades into a wall of text.
    let result = null;
    try {
      const chunked = record.channels === 2 ? wavUtil.chunkStereo(buffer) : wavUtil.chunkMono(buffer);
      if (chunked) {
        result = await gemini.diarizeChunked({
          apiKey,
          model,
          mode: record.channels === 2 ? 'stereo' : 'mono',
          chunks: chunked.chunks,
          micName,
          sysName,
          signal: controller.signal,
          onProgress,
        });
      }
    } catch (err) {
      if (controller.signal.aborted) throw err;
      console.warn('[diarize] fell back to the plain text pipeline:', err.message);
    }

    let updated;
    if (result) {
      updated = await storage.setTranscriptAndSegments(record.id, result);
    } else {
      // Legacy pipeline — plain text, channel-based labels for stereo.
      let text;
      if (record.channels === 2) {
        const chunked = wavUtil.chunkStereo(buffer);
        if (chunked) {
          text = await gemini.transcribeConversationChunked({
            apiKey,
            model,
            chunks: chunked.chunks,
            micName,
            sysName,
            signal: controller.signal,
            onProgress,
          });
        }
      }
      if (text === undefined) {
        text = await gemini.transcribeFile({ apiKey, model, filePath, signal: controller.signal });
      }
      updated = await storage.setTranscript(record.id, text);
    }
    const text = updated.transcript;
    send('recording:updated', updated);

    // Best-effort summary title + embedding (don't fail the transcript on these).
    if (text) {
      try {
        const title = await gemini.generateTitle({ apiKey, model, transcript: text, signal: controller.signal });
        if (title) {
          updated = await storage.setAutoTitle(record.id, title);
          send('recording:updated', updated);
        }
      } catch (e) {
        console.warn('[title] failed:', e.message);
      }
      try {
        const vec = await gemini.embedText({ apiKey, text, signal: controller.signal });
        await storage.setEmbedding(record.id, vec);
      } catch (e) {
        console.warn('[embed] failed:', e.message);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[transcribe] failed:', err);
    const updated = await storage.setError(record.id, err.message || 'Transcription failed.');
    send('recording:updated', updated);
  } finally {
    inFlight.delete(record.id);
  }
}

// --- IPC ------------------------------------------------------------------

function wireIpc() {
  ipcMain.handle('settings:get', () => config.publicSettings());

  ipcMain.handle('settings:setApiKey', async (_e, key) => {
    await config.setApiKey(key);
    return config.publicSettings();
  });

  ipcMain.handle('settings:verifyKey', async (_e, key) => {
    try {
      return { ok: await gemini.verifyKey((key || '').trim()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:setModel', async (_e, model) => {
    await config.setModel(model);
    return config.publicSettings();
  });

  ipcMain.handle('settings:setTheme', async (_e, theme) => {
    await config.setTheme(theme);
    nativeTheme.themeSource = config.getTheme(); // drives native chrome + renderer prefers-color-scheme
    return config.publicSettings();
  });

  // Try to claim a new global shortcut; roll back to the old one if it's taken.
  ipcMain.handle('settings:setShortcut', async (_e, accel) => {
    const previous = config.getShortcut();
    const ok = applyShortcut(accel);
    if (!ok) {
      applyShortcut(previous); // restore — the requested combo is unavailable
      return { ok: false, settings: config.publicSettings() };
    }
    await config.setShortcut(accel);
    return { ok: true, settings: config.publicSettings() };
  });

  ipcMain.handle('settings:resetShortcut', async () => {
    applyShortcut(config.DEFAULT_SHORTCUT);
    await config.setShortcut(config.DEFAULT_SHORTCUT);
    return { ok: true, settings: config.publicSettings() };
  });

  ipcMain.handle('settings:setSystemAudio', async (_e, on) => {
    await config.setSystemAudio(on);
    return config.publicSettings();
  });

  ipcMain.handle('settings:setUserName', async (_e, name) => {
    await config.setUserName(name);
    return config.publicSettings();
  });

  // Route system output through BlackHole for the duration of a recording by
  // building a Multi-Output Device of (current listening device + BlackHole).
  // Returns { ok, original, bluetooth, listen }. We remember `original` so we can
  // always put the user's output back — even across a crash.
  ipcMain.handle('systemAudio:begin', async () => {
    const res = await runHelper(['begin']);
    if (res && res.ok && res.original) {
      await config.setPendingOutputRestore(res.original);
      volumeDeviceUID = res.original.split('\t')[0]; // the real device the volume keys drive
      startVolumeListener(volumeDeviceUID);
    }
    return res;
  });

  // Restore the user's normal output device and tear down the Multi-Output Device.
  ipcMain.handle('systemAudio:end', async () => {
    stopVolumeListener();
    volumeDeviceUID = null;
    const original = config.getPendingOutputRestore() || '';
    const res = await runHelper(['end', original]);
    await config.setPendingOutputRestore(null);
    return res;
  });

  // Deep-link to Accessibility settings (so the volume keys can work while recording).
  ipcMain.handle('app:openAccessibility', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });

  // Is a loopback input (BlackHole) installed? Drives the Settings hint.
  ipcMain.handle('systemAudio:check', () => runHelper(['check']));

  // Best-effort name of the app whose audio we're capturing (for speaker labels).
  ipcMain.handle('audio:sourceName', async () => {
    if (lastActiveApp && !isSelfApp(lastActiveApp)) return lastActiveApp;
    const fm = await getFrontmostApp();
    return isSelfApp(fm) ? null : fm;
  });

  // --- semantic search ---
  ipcMain.handle('search:embedQuery', async (_e, text) => {
    const apiKey = config.getApiKey();
    if (!apiKey) return { ok: false, reason: 'no_key' };
    try {
      return { ok: true, vector: await gemini.embedText({ apiKey, text }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('recordings:embeddings', () => storage.loadEmbeddings());

  // Generate embeddings for any transcribed recordings that don't have one yet.
  // Embeds in parallel batches so indexing finishes in a couple of seconds.
  ipcMain.handle('search:backfill', async () => {
    const apiKey = config.getApiKey();
    if (!apiKey) return { ok: false, reason: 'no_key' };
    const records = await storage.loadManifest();
    const embs = await storage.loadEmbeddings();
    const todo = records.filter((r) => r.status === 'done' && r.transcript && !embs[r.id]);
    let added = 0;
    const CONCURRENCY = 6;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = todo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (r) => {
          try {
            return { id: r.id, v: await gemini.embedText({ apiKey, text: r.transcript }) };
          } catch {
            return null;
          }
        })
      );
      for (const res of results) {
        if (res) {
          await storage.setEmbedding(res.id, res.v); // sequential writes — no file race
          added++;
        }
      }
    }
    return { ok: true, added };
  });

  ipcMain.handle('mic:ensureAccess', () => ensureMicAccess());

  ipcMain.handle('mic:openSettings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    );
  });

  ipcMain.handle('recordings:list', () => storage.loadManifest());

  ipcMain.handle('recordings:transcript', (_e, id) => storage.readTranscript(id));

  ipcMain.handle('recordings:segments', (_e, id) => storage.readSegments(id));

  ipcMain.handle('recordings:renameSpeaker', (_e, id, speakerId, label) =>
    storage.renameSpeaker(id, speakerId, label)
  );

  ipcMain.handle('recordings:setTitle', (_e, id, title) => storage.setTitle(id, title));

  ipcMain.handle('recordings:delete', async (_e, id, alsoCloud) => {
    const ctrl = inFlight.get(id);
    if (ctrl) ctrl.abort();
    if (alsoCloud) await cloud.deleteCloud(id); // best-effort; local delete proceeds regardless
    return storage.deleteRecording(id);
  });

  // --- cloud sharing ---
  ipcMain.handle('cloud:redeem', (_e, code, displayName) => cloud.redeemInvite(code, displayName));
  ipcMain.handle('cloud:status', () => cloud.status());
  ipcMain.handle('cloud:signOut', () => cloud.signOut());
  ipcMain.handle('share:profiles', () => cloud.listProfiles());
  ipcMain.handle('share:status', (_e, id) => cloud.shareStatus(id));
  ipcMain.handle('share:create', (_e, opts) => cloud.shareCreate(opts));
  ipcMain.handle('share:revokeUser', (_e, id, recipientId) => cloud.revokeShare(id, recipientId));
  ipcMain.handle('share:revokeLink', (_e, id) => cloud.revokeLink(id));
  ipcMain.handle('share:deleteCloud', (_e, id) => cloud.deleteCloud(id));
  ipcMain.handle('inbox:list', () => cloud.listInbox());
  ipcMain.handle('inbox:markSeen', (_e, shareId) => cloud.markSeen(shareId));
  ipcMain.handle('inbox:play', (_e, shareId) => cloud.playShared(shareId));

  ipcMain.handle('recordings:reveal', async (_e, id) => {
    const record = await storage.getRecord(id);
    if (record) shell.showItemInFolder(storage.absAudioPath(record));
  });

  // Export a transcript to a user-chosen .txt via the native save dialog.
  ipcMain.handle('recordings:export', async (_e, id) => {
    const record = await storage.getRecord(id);
    if (!record) return { ok: false };
    const text = await storage.readTranscript(id);
    if (!text.trim()) return { ok: false, reason: 'empty' };
    const safeTitle = (record.title || 'transcript').replace(/[^\w\-]+/g, '_').slice(0, 40);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save transcript',
      defaultPath: `${safeTitle}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: 'canceled' };
    await fsp.writeFile(filePath, text, 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('recordings:audioPath', async (_e, id) => {
    const record = await storage.getRecord(id);
    return record ? storage.absAudioPath(record) : null;
  });

  ipcMain.handle('app:openRoot', () => shell.openPath(storage.getRoot()));

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Save a freshly recorded WAV, then kick off transcription asynchronously.
  ipcMain.handle('recording:save', async (_e, payload) => {
    const { wav, durationSec, device, peaks, channels, micName, sysName, hasSystemAudio } = payload;
    const wavBuffer = Buffer.from(wav); // wav arrives as ArrayBuffer/Uint8Array
    const record = await storage.createRecording({
      wavBuffer,
      durationSec,
      device,
      peaks,
      channels,
      micName,
      sysName,
      hasSystemAudio,
      model: config.getModel(),
      createdAtISO: new Date().toISOString(),
    });
    // Don't await — let the renderer get its record immediately and show progress.
    runTranscription(record);
    return record;
  });

  // Retry transcription for an existing recording (after adding a key or an error).
  ipcMain.handle('recording:retry', async (_e, id) => {
    const record = await storage.getRecord(id);
    if (!record) return null;
    if (inFlight.has(id)) return record; // a run is already active — don't double-fire
    const reset = await storage.setTranscribing(id);
    send('recording:updated', reset);
    runTranscription(reset);
    return reset;
  });
}

// --- global shortcut ------------------------------------------------------

async function onShortcutFired() {
  // Capture the app the user was in BEFORE we steal focus (likely the call app).
  try {
    lastActiveApp = await getFrontmostApp();
  } catch {
    /* ignore */
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  send('shortcut:toggle');
}

// Register the given accelerator, releasing any previous one. Returns true on success.
function applyShortcut(accel) {
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
  }
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, onShortcutFired);
    if (ok) registeredShortcut = accel;
    return ok;
  } catch {
    return false;
  }
}

function registerShortcut() {
  applyShortcut(config.getShortcut());
}

// --- lifecycle ------------------------------------------------------------

app.whenReady().then(async () => {
  config.init();
  // Theme: a --theme= flag (screenshots) overrides the saved preference.
  nativeTheme.themeSource = themeArg ? themeArg.split('=')[1] : config.getTheme();
  const root = config.getRootDir();
  if (root) storage.setRoot(root);

  wirePermissions();
  wireIpc();
  createWindow();
  registerShortcut();

  // Cloud sharing: resume the saved identity and keep the inbox fresh when the
  // app comes back to the foreground.
  cloud.init({
    send,
    focus: () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.show();
        win.focus();
      }
    },
  });
  app.on('browser-window-focus', () => cloud.pollSoon());
  require('electron').powerMonitor.on('resume', () => cloud.pollSoon());

  // Recover audio routing if a previous run was force-quit while recording system
  // audio: restore the saved output device and remove any leftover Multi-Output Device.
  runHelper(['cleanup', config.getPendingOutputRestore() || ''])
    .then(() => config.setPendingOutputRestore(null))
    .catch(() => {});

  // Resume any transcriptions that were interrupted by a previous quit/crash.
  storage
    .loadManifest()
    .then((records) => {
      for (const r of records) if (r.status === 'transcribing') runTranscription(r);
    })
    .catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopVolumeListener();
  for (const ctrl of inFlight.values()) ctrl.abort();
  // If a system-audio recording's routing is still active, restore output now
  // (synchronously, since the app is going away).
  const pending = config.getPendingOutputRestore();
  if (pending) {
    try {
      require('child_process').execFileSync(helperPath(), ['end', pending], { timeout: 3000 });
    } catch {
      /* launch cleanup will recover it next time */
    }
  }
});

// Expose the toggle shortcut label to the renderer via a simple getter.
ipcMain.handle('app:shortcut', () => config.getShortcut());

// Clipboard writes run in the main process: the renderer's async clipboard
// rejects when the window loses focus mid-action, this never does.
ipcMain.handle('app:copyText', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});
