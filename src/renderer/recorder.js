// Microphone capture → clean 16 kHz mono 16-bit WAV, with a live level callback.
//
// Strategy: ask for a 16 kHz AudioContext so Chromium resamples for us; if the
// hardware rejects that, run at native rate and downsample in JS. An AudioWorklet
// collects Float32 frames off the main thread; on stop we concat → (downsample) →
// Int16 → WAV. RMS of each frame drives the UI meter.

const TARGET_RATE = 16000;

// The worklet is loaded from an inline Blob rather than a file:// URL — worklet
// module loading from file:// is unreliable across Chromium/Electron versions.
const WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

export class Recorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel || (() => {});
    this.reset();
  }

  reset() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.sysStream = null;
    this.sysSource = null;
    this.sysGain = null;
    this.sysWorklet = null;
    this.systemAudio = false; // requested
    this.systemDeviceId = null; // loopback input device for system audio (BlackHole)
    this.systemAudioActive = false; // actually capturing
    this.frames = []; // microphone frames
    this.frameCount = 0;
    this.sysFrames = []; // system-audio frames (separate track)
    this.sysFrameCount = 0;
    this.inputRate = TARGET_RATE;
    this.recording = false;
    this.level = 0;
    this.startedAt = 0;
    this._onTrackEnded = null;
  }

  get isRecording() {
    return this.recording;
  }

  // Start capturing from a specific device (or system default when deviceId is
  // null / 'default' / 'auto').
  async start(deviceId, opts = {}) {
    if (this.recording) return;
    this.systemAudio = Boolean(opts.systemAudio);
    this.systemDeviceId = opts.systemDeviceId || null; // a loopback input (BlackHole) if present
    this.systemAudioActive = false;
    await this._openInput(deviceId);
    this.frames = [];
    this.frameCount = 0;
    this.sysFrames = [];
    this.sysFrameCount = 0;
    this.recording = true;
    this.startedAt = performance.now();
  }

  // Switch the input device WITHOUT losing the take in progress (frames are kept
  // and the timer keeps running). Used when headphones drop out mid-recording.
  async swapInput(deviceId) {
    if (!this.recording) return;
    this._teardownInput();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    await this._openInput(deviceId);
  }

  // Open a mic → AudioContext(16k) → worklet graph. Shared by start() and swapInput().
  async _openInput(deviceId) {
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    const specific = deviceId && deviceId !== 'default' && deviceId !== 'auto';
    if (specific) audioConstraints.deviceId = { exact: deviceId };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      if (err && err.name === 'OverconstrainedError' && specific) {
        // The chosen mic vanished — fall back to the system default.
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioConstraints, deviceId: undefined } });
      } else {
        throw err;
      }
    }

    // Force 16 kHz so frames stay rate-consistent even across a mid-record swap.
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.inputRate = this.ctx.sampleRate;

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.worklet.port.onmessage = (e) => this._onMicFrame(e.data);
    this.source.connect(this.worklet);
    // Deliberately NOT connected to ctx.destination — that would echo through speakers.

    // System audio is captured on its OWN worklet (separate track) so we can keep
    // the mic and system audio apart for speaker-labeled transcription.
    if (this.systemAudio) await this._attachSystemAudio();

    const track = this.stream.getAudioTracks()[0];
    if (track) {
      this._onTrackEnded = () => this.onLevel(0, { lost: true });
      track.addEventListener('ended', this._onTrackEnded);
    }
  }

  // Capture the Mac's audio output (loopback) and mix it into the worklet. Falls
  // back silently to mic-only if it's unavailable (no permission / older macOS).
  async _attachSystemAudio() {
    try {
      if (this.systemDeviceId) {
        // Preferred: capture system audio from a virtual loopback INPUT device
        // (e.g. BlackHole) that the user routes their output through. Reliable on
        // every macOS version.
        this.sysStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: this.systemDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } else {
        // Fallback: the OS screen-share loopback (works on older macOS / Windows;
        // dead on macOS 26). We keep the video track alive (muted) so the capture
        // session doesn't tear down and silence the audio.
        this.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        this.sysStream.getVideoTracks().forEach((t) => (t.enabled = false));
      }
      const sysAudio = this.sysStream.getAudioTracks();
      if (!sysAudio.length) {
        console.warn('[recorder] system audio: stream had no audio track');
        this._stopSysStream();
        return;
      }
      const at = sysAudio[0];
      // Some macOS/Electron combos hand back a loopback track that's already
      // dead — treat that as "system audio unavailable" so we record mic-only.
      if (at.readyState === 'ended') {
        console.warn('[recorder] system audio loopback unavailable (track ended on arrival)');
        this._stopSysStream();
        this.systemAudioActive = false;
        return;
      }
      this.sysSource = this.ctx.createMediaStreamSource(new MediaStream([at]));
      this.sysGain = this.ctx.createGain();
      this.sysGain.gain.value = 1.0;
      this.sysWorklet = new AudioWorkletNode(this.ctx, 'pcm-capture', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      this.sysWorklet.port.onmessage = (e) => this._onSysFrame(e.data);
      this.sysSource.connect(this.sysGain).connect(this.sysWorklet);
      this.systemAudioActive = true;
    } catch (err) {
      console.warn('[recorder] system audio unavailable:', err && err.name);
      this._stopSysStream();
      this.systemAudioActive = false;
    }
  }

  _stopSysStream() {
    try {
      if (this.sysSource) this.sysSource.disconnect();
      if (this.sysGain) this.sysGain.disconnect();
      if (this.sysWorklet) this.sysWorklet.disconnect();
    } catch {
      /* ignore */
    }
    this.sysSource = null;
    this.sysGain = null;
    this.sysWorklet = null;
    if (this.sysStream) {
      this.sysStream.getTracks().forEach((t) => t.stop());
      this.sysStream = null;
    }
  }

  // Release the current mic + graph (without touching frames or ctx).
  _teardownInput() {
    this._stopSysStream();
    try {
      if (this.source) this.source.disconnect();
      if (this.worklet) this.worklet.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.worklet = null;
    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];
      if (track && this._onTrackEnded) track.removeEventListener('ended', this._onTrackEnded);
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this._onTrackEnded = null;
  }

  _onMicFrame(frame) {
    if (!this.recording) return;
    this.frames.push(frame);
    this.frameCount += frame.length;

    // RMS → smoothed level for the meter (the orb reacts to your voice).
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = Math.max(rms, this.level * 0.82); // fast attack, slow decay
    this.onLevel(this.level, { rms });
  }

  _onSysFrame(frame) {
    if (!this.recording) return;
    this.sysFrames.push(frame);
    this.sysFrameCount += frame.length;
    // Let the live waveform / orb react to system audio too — so the waves move
    // when (say) Spotify is playing even if you aren't talking.
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    if (rms > this.level) this.level = rms; // mic's decay still applies in _onMicFrame
  }

  get elapsedSec() {
    if (!this.recording) return 0;
    return (performance.now() - this.startedAt) / 1000;
  }

  // Stop, release the mic, and return { wav: ArrayBuffer, durationSec, sampleRate }.
  async stop() {
    if (!this.recording) return null;
    this.recording = false;

    const durationSec = this.frameCount / this.inputRate;

    try {
      if (this.source) this.source.disconnect();
      if (this.worklet) this.worklet.disconnect();
    } catch {
      /* ignore */
    }
    this._stopSysStream();
    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];
      if (track && this._onTrackEnded) track.removeEventListener('ended', this._onTrackEnded);
      this.stream.getTracks().forEach((t) => t.stop()); // clears the macOS mic indicator
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }

    const micMono = toMono16k(this.frames, this.frameCount, this.inputRate);

    // Only save as a stereo (mic + system) recording if the system track actually
    // carried audio. Otherwise it's mono mic-only — this avoids silent right
    // channels and the bogus speaker labels they cause.
    let sysMono = null;
    let sysHasSignal = false;
    if (this.systemAudioActive && this.sysFrameCount > 0) {
      sysMono = toMono16k(this.sysFrames, this.sysFrameCount, this.inputRate);
      let mx = 0;
      for (let i = 0; i < sysMono.length; i++) if (Math.abs(sysMono[i]) > mx) mx = Math.abs(sysMono[i]);
      sysHasSignal = mx >= 0.001;
      console.log('[recorder] system audio maxAmplitude=' + mx.toFixed(4) + ' hasSignal=' + sysHasSignal);
    }

    let wav;
    let channels;
    let peakSrc;
    if (sysHasSignal) {
      wav = encodeWavStereo(micMono, sysMono, TARGET_RATE);
      channels = 2;
      peakSrc = mixMono(micMono, sysMono);
    } else {
      wav = encodeWav(micMono, TARGET_RATE);
      channels = 1;
      peakSrc = micMono;
    }
    const peaks = extractPeaks(peakSrc, 40);

    this.reset();
    return { wav, durationSec, sampleRate: TARGET_RATE, peaks, channels };
  }

  // Cancel without producing a file.
  async cancel() {
    if (!this.recording && !this.ctx) return;
    this.recording = false;
    this._stopSysStream();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.reset();
  }
}

function mergeFrames(frames, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function toMono16k(frames, total, inputRate) {
  const merged = mergeFrames(frames, total);
  return inputRate === TARGET_RATE ? merged : downsample(merged, inputRate, TARGET_RATE);
}

// Sum two mono tracks (for the decorative waveform peaks only).
function mixMono(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, a[i] + b[i] * 0.9));
  return out;
}

// Interleave two mono tracks into a 16-bit PCM stereo WAV (L=left, R=right).
function encodeWavStereo(left, right, sampleRate) {
  const n = Math.min(left.length, right.length);
  const dataSize = n * 4; // 2 channels × 2 bytes
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeTag = (offset, tag) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate = rate * channels * bytes
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < n; i++) {
    view.setInt16(offset, f32ToI16(left[i]), true);
    offset += 2;
    view.setInt16(offset, f32ToI16(right[i]), true);
    offset += 2;
  }
  return buffer;
}

// Box-average decimation — also acts as a crude anti-aliasing lowpass.
function downsample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < input.length; j++) {
      sum += input[j];
      n++;
    }
    out[i] = n ? sum / n : input[start] || 0;
  }
  return out;
}

// Reduce the whole take to N normalized peak buckets for a real mini-waveform.
function extractPeaks(samples, n) {
  const peaks = new Array(n).fill(0);
  if (!samples.length) return peaks;
  const bucket = samples.length / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.floor((i + 1) * bucket);
    let peak = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize to 0..1 so quiet recordings still show a legible shape.
  const scale = max > 0 ? 1 / max : 1;
  return peaks.map((p) => Math.round(Math.min(1, p * scale) * 1000) / 1000);
}

function f32ToI16(s) {
  s = Math.max(-1, Math.min(1, s));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

// Canonical 44-byte RIFF/WAVE PCM header + little-endian Int16 samples.
function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeTag = (offset, tag) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt '); // trailing space is mandatory
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * bytes/sample
  view.setUint16(32, 2, true); // block align = channels * bytes/sample
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, f32ToI16(samples[i]), true);
    offset += 2;
  }
  return buffer;
}
