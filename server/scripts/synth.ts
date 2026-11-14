/**
 * A small music synthesiser. Every seed track is generated here from numbers
 * alone, using no samples, so PeerBeats owns the audio and can release it as CC0.
 */
export type Genre = 'Lo-Fi' | 'Synthwave' | 'Ambient' | 'House' | 'Chiptune';

export interface SynthSpec {
  genre: Genre;
  bpm: number;
  root: number; // MIDI note of the key's root
  scale: keyof typeof SCALES;
  progression: number[]; // scale degrees, one chord per bar (0 = tonic)
  seed: number;
  targetSec: number;
}

const RATE = 44100;
const TAU = Math.PI * 2;

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
} as const;

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Wave = (phase: number) => number;
const sine: Wave = (p) => Math.sin(p * TAU);
const triangle: Wave = (p) => 4 * Math.abs(((p % 1) + 1) % 1 - 0.5) - 1;
const saw: Wave = (p) => 2 * (((p % 1) + 1) % 1) - 1;
const square: (duty: number) => Wave = (duty) => (p) => (((p % 1) + 1) % 1 < duty ? 1 : -1);
const keys: Wave = (p) =>
  Math.sin(p * TAU) + 0.28 * Math.sin(p * TAU * 2) + 0.1 * Math.sin(p * TAU * 3) + 0.03 * Math.sin(p * TAU * 7);
const warmStack: Wave = (p) =>
  Math.sin(p * TAU) + 0.42 * Math.sin(p * TAU * 2) + 0.2 * Math.sin(p * TAU * 3) + 0.08 * Math.sin(p * TAU * 5);

class Mix {
  left: Float32Array;
  right: Float32Array;
  sendL: Float32Array;
  sendR: Float32Array;
  length: number;

  constructor(seconds: number) {
    this.length = Math.ceil(seconds * RATE);
    this.left = new Float32Array(this.length);
    this.right = new Float32Array(this.length);
    this.sendL = new Float32Array(this.length);
    this.sendR = new Float32Array(this.length);
  }

  note(opts: {
    at: number;
    dur: number;
    hz: number;
    gain: number;
    wave: Wave;
    pan?: number;
    attack?: number;
    release?: number;
    decay?: number; // exponential decay rate per second; 0 means sustained
    send?: number;
    detune?: number; // voices spread by this ratio
    lowpass?: number; // one-pole cutoff in Hz
  }) {
    const { at, dur, hz, gain, wave, pan = 0, attack = 0.005, release = 0.05, decay = 0, send = 0, detune = 0, lowpass = 0 } = opts;
    const start = Math.floor(at * RATE);
    const total = Math.floor((dur + release) * RATE);
    const leftGain = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    const voices = detune ? [1 - detune, 1, 1 + detune] : [1];
    const norm = 1 / voices.length;
    const a = lowpass ? 1 - Math.exp((-TAU * lowpass) / RATE) : 1;
    let low = 0;
    for (let i = 0; i < total; i++) {
      const pos = start + i;
      if (pos >= this.length) break;
      const t = i / RATE;
      let env = 1;
      if (t < attack) env = t / attack;
      if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
      if (decay) env *= Math.exp(-decay * t);
      let sample = 0;
      for (const v of voices) sample += wave(hz * v * t + v);
      sample *= norm;
      if (lowpass) {
        low += a * (sample - low);
        sample = low;
      }
      const value = sample * env;
      this.left[pos] += value * leftGain;
      this.right[pos] += value * rightGain;
      if (send) {
        this.sendL[pos] += value * leftGain * send;
        this.sendR[pos] += value * rightGain * send;
      }
    }
  }

  kick(at: number, gain: number) {
    const start = Math.floor(at * RATE);
    const total = Math.floor(0.32 * RATE);
    let phase = 0;
    for (let i = 0; i < total && start + i < this.length; i++) {
      const t = i / RATE;
      phase += (46 + 95 * Math.exp(-t * 32)) / RATE;
      const v = Math.sin(phase * TAU) * Math.exp(-t * 11) * gain;
      this.left[start + i] += v;
      this.right[start + i] += v;
    }
  }

  noise(opts: { at: number; dur: number; gain: number; decay: number; random: () => number; highpass?: boolean; tone?: number; pan?: number; send?: number; lowpass?: number }) {
    const { at, dur, gain, decay, random, highpass = false, tone = 0, pan = 0, send = 0, lowpass = 0 } = opts;
    const start = Math.floor(at * RATE);
    const total = Math.floor(dur * RATE);
    const leftGain = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    const a = lowpass ? 1 - Math.exp((-TAU * lowpass) / RATE) : 1;
    let previous = 0;
    let low = 0;
    for (let i = 0; i < total && start + i < this.length; i++) {
      const t = i / RATE;
      const white = random() * 2 - 1;
      let s = highpass ? white - previous : white;
      previous = white;
      if (lowpass) {
        low += a * (s - low);
        s = low;
      }
      if (tone) s = s * 0.72 + Math.sin(t * tone * TAU) * 0.5;
      const value = s * Math.exp(-decay * t);
      const pos = start + i;
      this.left[pos] += value * leftGain;
      this.right[pos] += value * rightGain;
      if (send) {
        this.sendL[pos] += value * leftGain * send;
        this.sendR[pos] += value * rightGain * send;
      }
    }
  }

  /** A light Schroeder reverb fed from the send bus. */
  reverb(mix: number, roomScale = 1) {
    const process = (input: Float32Array, out: Float32Array, spread: number) => {
      const wet = new Float32Array(input.length);
      for (const d of [1557, 1617, 1491, 1422]) {
        const delay = Math.floor((d + spread) * roomScale);
        const buf = new Float32Array(delay);
        let idx = 0;
        for (let i = 0; i < input.length; i++) {
          const y = buf[idx];
          buf[idx] = input[i] + y * 0.82;
          idx = (idx + 1) % delay;
          wet[i] += y * 0.25;
        }
      }
      for (const d of [225, 556]) {
        const buf = new Float32Array(d + spread);
        let idx = 0;
        for (let i = 0; i < input.length; i++) {
          const b = buf[idx];
          const x = wet[i];
          const y = -x + b;
          buf[idx] = x + b * 0.5;
          idx = (idx + 1) % buf.length;
          wet[i] = y;
        }
      }
      for (let i = 0; i < out.length; i++) out[i] += wet[i] * mix;
    };
    process(this.sendL, this.left, 0);
    process(this.sendR, this.right, 23);
  }

  /** A tempo-synced stereo echo, also fed from the send bus. */
  echo(seconds: number, feedback: number, mix: number) {
    const delay = Math.floor(seconds * RATE);
    const process = (input: Float32Array, out: Float32Array) => {
      const buf = new Float32Array(delay);
      let idx = 0;
      for (let i = 0; i < input.length; i++) {
        const y = buf[idx];
        buf[idx] = input[i] + y * feedback;
        idx = (idx + 1) % delay;
        out[i] += y * mix;
      }
    };
    process(this.sendL, this.left);
    process(this.sendR, this.right);
  }

  master(seconds: number) {
    let peak = 0.0001;
    for (let i = 0; i < this.length; i++) {
      peak = Math.max(peak, Math.abs(this.left[i]), Math.abs(this.right[i]));
    }
    const drive = 1.25 / peak;
    const fadeIn = 1.5 * RATE;
    const fadeOut = 4 * RATE;
    const end = Math.floor(seconds * RATE);
    for (let i = 0; i < this.length; i++) {
      let fade = 1;
      if (i < fadeIn) fade = i / fadeIn;
      if (i > end - fadeOut) fade = Math.max(0, (end - i) / fadeOut);
      this.left[i] = Math.tanh(this.left[i] * drive) * 0.86 * fade;
      this.right[i] = Math.tanh(this.right[i] * drive) * 0.86 * fade;
    }
  }
}

function wav(left: Float32Array, right: Float32Array, frames: number): Buffer {
  const bytes = frames * 4;
  const out = Buffer.alloc(44 + bytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return out;
}

/** Song form, as fractions of the whole track: intro, A, break, B, outro. */
function sectionAt(bar: number, bars: number) {
  const p = bar / bars;
  if (p < 0.125) return 'intro';
  if (p < 0.5) return 'a';
  if (p < 0.625) return 'break';
  if (p < 0.875) return 'b';
  return 'outro';
}

export function renderTrack(spec: SynthSpec): Buffer {
  const random = rng(spec.seed);
  const beat = 60 / spec.bpm;
  const barLen = beat * 4;
  const bars = Math.max(16, Math.round(spec.targetSec / barLen / 4) * 4);
  const seconds = bars * barLen + 3;
  const mix = new Mix(seconds);
  const scale = SCALES[spec.scale];

  const pitch = (degree: number, octave = 0) => {
    const n = scale.length;
    const wrapped = ((degree % n) + n) % n;
    return spec.root + scale[wrapped] + 12 * (octave + Math.floor(degree / n));
  };
  const chord = (degree: number, withSeventh = false) => {
    const notes = [pitch(degree), pitch(degree + 2), pitch(degree + 4)];
    if (withSeventh) notes.push(pitch(degree + 6));
    return notes;
  };

  // A repeating melody motif, so each track has a recognisable hook.
  const pentatonic = [0, 2, 4, 7, 9];
  const motif: (number | null)[] = [];
  let walk = Math.floor(random() * pentatonic.length);
  for (let i = 0; i < 16; i++) {
    const density = spec.genre === 'Ambient' ? 0.16 : spec.genre === 'Lo-Fi' ? 0.36 : 0.5;
    if (random() < density || i === 0) {
      walk = Math.max(0, Math.min(pentatonic.length - 1, walk + Math.floor(random() * 5) - 2));
      motif.push(pentatonic[walk]);
    } else {
      motif.push(null);
    }
  }

  const swing = spec.genre === 'Lo-Fi' ? 0.11 : spec.genre === 'House' ? 0.03 : 0;
  const stepTime = (bar: number, step: number) =>
    bar * barLen + step * (beat / 4) + (step % 2 === 1 ? swing * beat : 0);

  for (let bar = 0; bar < bars; bar++) {
    const section = sectionAt(bar, bars);
    const degree = spec.progression[bar % spec.progression.length];
    const at = bar * barLen;
    const drums = section === 'a' || section === 'b';
    const bass = section !== 'intro' && section !== 'outro' && section !== 'break';
    const lead = section === 'b' || (section === 'a' && Math.floor(bar / 4) % 2 === 1) || section === 'break';

    if (spec.genre === 'Lo-Fi') {
      for (const m of chord(degree, true)) {
        mix.note({ at, dur: barLen * 0.92, hz: midiToHz(m), gain: 0.085, wave: keys, attack: 0.012, release: 0.3, decay: 0.55, send: 0.32, pan: (random() - 0.5) * 0.5, lowpass: 2100 });
      }
      if (bass) {
        mix.note({ at, dur: beat * 1.6, hz: midiToHz(pitch(degree, -2)), gain: 0.3, wave: sine, release: 0.08 });
        mix.note({ at: at + beat * 2.5, dur: beat, hz: midiToHz(pitch(degree + 4, -2)), gain: 0.22, wave: sine, release: 0.08 });
      }
      if (drums) {
        for (let s = 0; s < 16; s++) {
          const t = stepTime(bar, s);
          if (s === 0 || s === 7 || s === 10) mix.kick(t, 0.5);
          if (s === 4 || s === 12) mix.noise({ at: t, dur: 0.18, gain: 0.15, decay: 22, random, tone: 190, send: 0.2, lowpass: 3400 });
          if (s % 2 === 0) mix.noise({ at: t, dur: 0.05, gain: 0.05 + random() * 0.03, decay: 70, random, highpass: true, pan: 0.2 });
        }
      }
      if (lead) {
        motif.forEach((n, s) => {
          if (n === null) return;
          mix.note({ at: stepTime(bar, s), dur: beat * 0.5, hz: midiToHz(spec.root + 24 + n), gain: 0.09, wave: keys, decay: 5, release: 0.15, send: 0.5, pan: -0.15, lowpass: 2600 });
        });
      }
    }

    if (spec.genre === 'Synthwave') {
      for (const m of chord(degree)) {
        mix.note({ at, dur: barLen, hz: midiToHz(m + 12), gain: 0.07, wave: saw, detune: 0.004, attack: 0.15, release: 0.2, send: 0.42, lowpass: section === 'intro' ? 900 : 2200, pan: (m % 3) * 0.2 - 0.2 });
      }
      if (bass) {
        for (let s = 0; s < 8; s++) {
          mix.note({ at: at + (s * beat) / 2, dur: beat * 0.36, hz: midiToHz(pitch(degree, -2)), gain: 0.2, wave: saw, lowpass: 560, release: 0.03 });
        }
      }
      if (drums) {
        for (let b = 0; b < 4; b++) mix.kick(at + b * beat, 0.62);
        for (const b of [1, 3]) mix.noise({ at: at + b * beat, dur: 0.3, gain: 0.3, decay: 11, random, tone: 175, send: 0.6 });
        for (let s = 0; s < 8; s++) mix.noise({ at: at + (s * beat) / 2, dur: 0.05, gain: 0.04, decay: 60, random, highpass: true, pan: 0.25 });
      }
      const arp = chord(degree);
      for (let s = 0; s < 16; s++) {
        if (section === 'outro' && s % 2) continue;
        mix.note({ at: stepTime(bar, s), dur: beat * 0.2, hz: midiToHz(arp[s % 3] + 24), gain: 0.05, wave: saw, decay: 9, release: 0.05, send: 0.45, pan: Math.sin(s) * 0.5, lowpass: 3000 });
      }
      if (lead) {
        motif.forEach((n, s) => {
          if (n === null || s % 2) return;
          mix.note({ at: stepTime(bar, s), dur: beat * 0.8, hz: midiToHz(spec.root + 24 + n), gain: 0.1, wave: saw, detune: 0.003, attack: 0.02, release: 0.18, send: 0.6, lowpass: 2800 });
        });
      }
    }

    if (spec.genre === 'Ambient') {
      if (bar % 2 === 0) {
        for (const m of chord(degree, true)) {
          mix.note({ at, dur: barLen * 2.1, hz: midiToHz(m), gain: 0.1, wave: warmStack, detune: 0.0025, attack: 1.8, release: 2.2, send: 0.85, pan: (random() - 0.5) * 0.9, lowpass: 1500 });
        }
        mix.note({ at, dur: barLen * 2, hz: midiToHz(pitch(degree, -2)), gain: 0.2, wave: sine, attack: 1.5, release: 2 });
      }
      motif.forEach((n, s) => {
        if (n === null || s % 4 !== 0) return;
        mix.note({ at: stepTime(bar, s) + random() * 0.08, dur: 0.3, hz: midiToHz(spec.root + 24 + n), gain: 0.07, wave: sine, decay: 1.6, release: 1.5, send: 1, pan: (random() - 0.5) * 1.2 });
      });
    }

    if (spec.genre === 'House') {
      if (drums || section === 'outro') {
        for (let b = 0; b < 4; b++) mix.kick(at + b * beat, 0.72);
      }
      if (drums) {
        for (const b of [1, 3]) mix.noise({ at: at + b * beat, dur: 0.2, gain: 0.2, decay: 18, random, send: 0.35, tone: 230 });
        for (let b = 0; b < 4; b++) mix.noise({ at: at + (b + 0.5) * beat, dur: 0.14, gain: 0.11, decay: 24, random, highpass: true, pan: 0.15 });
        for (let s = 0; s < 16; s++) if (s % 4 === 3) mix.noise({ at: stepTime(bar, s), dur: 0.04, gain: 0.05, decay: 80, random, highpass: true, pan: -0.25 });
      }
      for (const stab of [0.5, 1.75, 3.5]) {
        for (const m of chord(degree, true)) {
          mix.note({ at: at + stab * beat, dur: beat * 0.26, hz: midiToHz(m + 12), gain: 0.07, wave: saw, detune: 0.003, release: 0.1, send: 0.55, lowpass: section === 'break' ? 1000 : 2600 });
        }
      }
      if (bass) {
        for (const off of [0.5, 1.5, 2.5, 3.25, 3.5]) {
          mix.note({ at: at + off * beat, dur: beat * 0.3, hz: midiToHz(pitch(degree, -2)), gain: 0.26, wave: triangle, release: 0.03, lowpass: 900 });
        }
      }
      if (lead && section !== 'a') {
        motif.forEach((n, s) => {
          if (n === null) return;
          mix.note({ at: stepTime(bar, s), dur: beat * 0.22, hz: midiToHz(spec.root + 24 + n), gain: 0.06, wave: keys, decay: 5, release: 0.08, send: 0.6, pan: 0.2 });
        });
      }
    }

    if (spec.genre === 'Chiptune') {
      const arp = chord(degree);
      for (let s = 0; s < 16; s++) {
        mix.note({ at: stepTime(bar, s), dur: beat * 0.22, hz: midiToHz(arp[s % 3] + 12), gain: 0.05, wave: square(0.25), release: 0.01, pan: -0.25 });
      }
      if (bass || section === 'break') {
        for (let s = 0; s < 8; s++) {
          const note = s % 4 === 3 ? pitch(degree + 4, -2) : pitch(degree, -2);
          mix.note({ at: at + (s * beat) / 2, dur: beat * 0.42, hz: midiToHz(note), gain: 0.24, wave: triangle, release: 0.01 });
        }
      }
      if (drums) {
        for (const b of [0, 2]) mix.note({ at: at + b * beat, dur: 0.09, hz: 70, gain: 0.34, wave: triangle, release: 0.01, decay: 18 });
        for (const b of [1, 3]) mix.noise({ at: at + b * beat, dur: 0.12, gain: 0.16, decay: 24, random });
        for (let s = 0; s < 8; s++) mix.noise({ at: at + (s * beat) / 2, dur: 0.03, gain: 0.035, decay: 100, random, highpass: true, pan: 0.2 });
      }
      if (lead || section === 'a') {
        motif.forEach((n, s) => {
          if (n === null) return;
          mix.note({ at: stepTime(bar, s), dur: beat * 0.3, hz: midiToHz(spec.root + 24 + n), gain: 0.09, wave: square(0.5), release: 0.02, pan: 0.15, send: 0.3 });
        });
      }
    }
  }

  if (spec.genre === 'Lo-Fi') {
    // Vinyl dust.
    for (let t = 0; t < seconds; t += 0.05 + random() * 0.4) {
      mix.noise({ at: t, dur: 0.004, gain: 0.02 + random() * 0.03, decay: 300, random, highpass: true, pan: random() - 0.5 });
    }
  }

  switch (spec.genre) {
    case 'Lo-Fi':
      mix.reverb(0.35, 0.8);
      break;
    case 'Synthwave':
      mix.echo(beat * 0.75, 0.35, 0.26);
      mix.reverb(0.42, 1.1);
      break;
    case 'Ambient':
      mix.echo(beat * 1.5, 0.45, 0.3);
      mix.reverb(0.75, 1.5);
      break;
    case 'House':
      mix.echo(beat * 0.75, 0.3, 0.2);
      mix.reverb(0.3, 0.9);
      break;
    case 'Chiptune':
      mix.echo(beat * 0.5, 0.25, 0.25);
      break;
  }

  mix.master(seconds);
  return wav(mix.left, mix.right, mix.length);
}
