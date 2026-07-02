'use strict';

// Minimal 16-bit PCM WAV helpers for the main process. We record calls as a
// stereo WAV (left = microphone, right = system audio) so both can be played
// back from one file and split apart for speaker-labeled transcription.

function readHeader(buf) {
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  // Locate the 'data' chunk (robust to extra chunks before it).
  let offset = 12;
  let dataOffset = 44;
  let dataSize = buf.length - 44;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, buf.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return { numChannels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

function encodeMonoWav(int16, sampleRate) {
  const dataSize = int16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], 44 + i * 2);
  return buf;
}

// Split a stereo WAV into { left, right } mono WAV buffers. Returns null if mono.
function splitStereo(buffer) {
  const { numChannels, sampleRate, dataOffset, dataSize } = readHeader(buffer);
  if (numChannels !== 2) return null;
  const frames = Math.floor(dataSize / 4); // 2 channels × 2 bytes
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = buffer.readInt16LE(dataOffset + i * 4);
    right[i] = buffer.readInt16LE(dataOffset + i * 4 + 2);
  }
  return { left: encodeMonoWav(left, sampleRate), right: encodeMonoWav(right, sampleRate) };
}

// Decode both channels of a stereo WAV into Int16Arrays. Returns null if mono.
function decodeStereo(buffer) {
  const { numChannels, sampleRate, dataOffset, dataSize } = readHeader(buffer);
  if (numChannels !== 2) return null;
  const frames = Math.floor(dataSize / 4);
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = buffer.readInt16LE(dataOffset + i * 4);
    right[i] = buffer.readInt16LE(dataOffset + i * 4 + 2);
  }
  return { left, right, sampleRate, frames };
}

// Split a stereo recording into time windows for chunked transcription. Long
// audio (many minutes) overwhelms one-shot transcription — the model stops
// segmenting and emits a wall of text — so we cut it into ~chunkSec windows and
// transcribe each independently. Boundaries snap to the quietest spot within
// ±snapSec of each nominal cut so we never slice through the middle of a word.
// Returns { sampleRate, durationSec, chunks: [{ startSec, endSec, left, right }] }
// where left/right are mono WAV buffers, or null for non-stereo input.
function chunkStereo(buffer, { chunkSec = 180, snapSec = 4 } = {}) {
  const decoded = decodeStereo(buffer);
  if (!decoded) return null;
  const { left: L, right: R, sampleRate, frames } = decoded;

  const chunkFrames = Math.max(1, Math.floor(chunkSec * sampleRate));
  const snapFrames = Math.max(0, Math.floor(snapSec * sampleRate));
  const win = Math.max(1, Math.floor(0.2 * sampleRate)); // 200ms energy window
  const step = Math.max(1, Math.floor(0.05 * sampleRate)); // search every 50ms

  // The quietest 200ms within ±snap of `center` — the safest place to cut.
  function quietest(center) {
    const lo = Math.max(win, center - snapFrames);
    const hi = Math.min(frames - win, center + snapFrames);
    if (hi <= lo) return Math.min(Math.max(center, 0), frames);
    let best = center;
    let bestE = Infinity;
    for (let c = lo; c <= hi; c += step) {
      let e = 0;
      for (let i = c - win; i < c + win; i++) e += Math.abs(L[i]) + Math.abs(R[i]);
      if (e < bestE) {
        bestE = e;
        best = c;
      }
    }
    return best;
  }

  const bounds = [0];
  let nominal = chunkFrames;
  // Stop adding cuts once the tail is too short to be worth its own chunk.
  while (nominal < frames - chunkFrames * 0.25) {
    const b = quietest(nominal);
    if (b > bounds[bounds.length - 1]) bounds.push(b);
    nominal += chunkFrames;
  }
  bounds.push(frames);

  const chunks = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    if (b <= a) continue;
    chunks.push({
      startSec: a / sampleRate,
      endSec: b / sampleRate,
      left: encodeMonoWav(L.subarray(a, b), sampleRate),
      right: encodeMonoWav(R.subarray(a, b), sampleRate),
    });
  }
  return { sampleRate, durationSec: frames / sampleRate, chunks };
}

module.exports = { splitStereo, decodeStereo, chunkStereo, encodeMonoWav, readHeader };
