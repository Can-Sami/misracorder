'use strict';

// One-off: re-transcribe an exported Misracorder recording with the chunked
// pipeline. Run under the app's Electron so safeStorage can decrypt the key:
//   node_modules/.bin/electron scripts/retranscribe.js <path-to.wav>
// Writes "<name>.txt" (overwrites) next to the WAV and prints progress.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, safeStorage } = require('electron');
const wav = require('../src/main/wav');
const gemini = require('../src/main/gemini');

function decodeKey() {
  // Mirror config.getApiKey() without pulling the whole config module.
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    /* ignore */
  }
  const enc = cfg.apiKeyEnc;
  if (enc?.plain) return { key: enc.plain, model: cfg.model };
  if (enc?.enc) {
    try {
      return { key: safeStorage.decryptString(Buffer.from(enc.enc, 'base64')), model: cfg.model };
    } catch (e) {
      console.error('[key] decrypt failed:', e.message);
    }
  }
  return { key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null, model: cfg.model };
}

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath) throw new Error('usage: electron scripts/retranscribe.js <file.wav>');

  const { key, model: cfgModel } = decodeKey();
  if (!key) throw new Error('No Gemini API key available (decrypt failed and no env var).');

  // Pull speaker names + model from the sidecar JSON if present.
  let micName = 'Me';
  let sysName = 'System Sound';
  let model = cfgModel || 'gemini-2.5-flash';
  const jsonPath = wavPath.replace(/\.wav$/i, '.json');
  try {
    const meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    if (meta.micName) micName = meta.micName;
    if (meta.sysName) sysName = meta.sysName;
    if (meta.model) model = meta.model;
  } catch {
    /* no sidecar — defaults */
  }

  const buffer = await fsp.readFile(wavPath);
  const chunked = wav.chunkStereo(buffer);
  if (!chunked) throw new Error('Not a stereo recording — nothing to merge.');
  console.error(
    `[retranscribe] ${Math.round(chunked.durationSec)}s audio → ${chunked.chunks.length} chunks` +
      ` | mic="${micName}" sys="${sysName}" model=${model}`
  );

  const text = await gemini.transcribeConversationChunked({
    apiKey: key,
    model,
    chunks: chunked.chunks,
    micName,
    sysName,
    onProgress: (done, total) => console.error(`[retranscribe] chunk ${done}/${total} done`),
  });

  const outPath = wavPath.replace(/\.wav$/i, '.txt');
  await fsp.writeFile(outPath, text + '\n', 'utf8');
  console.error(`[retranscribe] wrote ${outPath} (${text.length} chars, ${text.split('\n').length} lines)`);
}

app.whenReady().then(async () => {
  try {
    if (app.dock) app.dock.hide();
    await main();
    app.exit(0);
  } catch (e) {
    console.error('[retranscribe] ERROR:', e.message);
    app.exit(1);
  }
});
