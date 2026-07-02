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

// Launched as `electron scripts/retranscribe.js`, Electron defaults to its own
// userData dir + Keychain identity — point both at the real app's so the
// encrypted key can be found and decrypted.
app.setName('Misracorder');
app.setPath('userData', path.join(app.getPath('appData'), 'Misracorder'));

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
  const stereo = wav.chunkStereo(buffer);
  const chunked = stereo || wav.chunkMono(buffer);
  if (!chunked) throw new Error('Not a 16-bit PCM WAV Misracorder recording.');
  const mode = stereo ? 'stereo' : 'mono';
  console.error(
    `[retranscribe] ${Math.round(chunked.durationSec)}s ${mode} audio → ${chunked.chunks.length} chunks` +
      ` | mic="${micName}" sys="${sysName}" model=${model}`
  );

  const result = await gemini.diarizeChunked({
    apiKey: key,
    model,
    mode,
    chunks: chunked.chunks,
    micName,
    sysName,
    onProgress: (done, total) => console.error(`[retranscribe] chunk ${done}/${total} done`),
  });

  const outPath = wavPath.replace(/\.wav$/i, '.txt');
  await fsp.writeFile(outPath, result.text + '\n', 'utf8');
  const segPath = wavPath.replace(/\.wav$/i, '.segments.json');
  await fsp.writeFile(
    segPath,
    JSON.stringify(
      { version: 1, language: result.language, speakers: result.speakers, segments: result.segments },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.error(
    `[retranscribe] wrote ${outPath} (${result.text.length} chars) + ${path.basename(segPath)} ` +
      `(${result.speakers.length} speakers: ${result.speakers.map((s) => s.label).join(', ')})`
  );
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
