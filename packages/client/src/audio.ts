import type { Cue } from './game/session';

/**
 * Everything is synthesized with Web Audio, so there are no sound files to load.
 * Levels are kept low: the BGM is a quiet ballpark-organ loop and effects are short.
 */
const MASTER = 0.8;
const BGM_LEVEL = 0.45;
const SFX_LEVEL = 0.9;
const MUTE_KEY = 'vaseball.muted';

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Glide to this frequency over the note. */
  to?: number;
  dest?: AudioNode;
}

interface NoiseOptions {
  gain?: number;
  filter?: BiquadFilterType;
  freq?: number;
  q?: number;
  attack?: number;
  dest?: AudioNode;
}

const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12);

// Eight bars of 8th notes over C - Am - F - G, twice; 0 is a rest.
const MELODY = [
  76, 0, 79, 0, 81, 79, 76, 0, 72, 0, 76, 0, 74, 72, 69, 0, 81, 0, 84, 0, 81, 79, 77, 0, 79, 0, 0, 74, 76, 0, 74, 0,
  76, 0, 79, 0, 84, 0, 81, 0, 79, 76, 0, 72, 74, 0, 76, 0, 77, 0, 81, 0, 79, 0, 76, 0, 74, 0, 0, 67, 71, 0, 74, 0,
];
const CHORDS = [
  { bass: 48, pad: [60, 64, 67] },
  { bass: 45, pad: [57, 60, 64] },
  { bass: 41, pad: [57, 60, 65] },
  { bass: 43, pad: [55, 59, 62] },
];
const BGM_STEP_SEC = 60 / 92 / 2;

export class Sound {
  muted: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private bgm: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private bgmTimer: number | null = null;
  private bgmStep = 0;
  private bgmNext = 0;

  constructor() {
    let muted = false;
    try {
      muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      // Storage can be unavailable (private mode); sound just starts on.
    }
    this.muted = muted;
  }

  /** Must be called from a user gesture: browsers only start audio after one. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER;
      this.master.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = SFX_LEVEL;
      this.sfx.connect(this.master);
      // The BGM goes through a gentle low-pass so it stays in the background.
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 2600;
      soften.connect(this.master);
      this.bgm = ctx.createGain();
      this.bgm.gain.value = BGM_LEVEL;
      this.bgm.connect(soften);
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // Not remembered; fine.
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  startBgm(): void {
    const ctx = this.ctx;
    if (!ctx || this.bgmTimer !== null) return;
    this.bgmStep = 0;
    this.bgmNext = ctx.currentTime + 0.1;
    this.bgmTimer = window.setInterval(() => this.scheduleBgm(), 100);
  }

  stopBgm(): void {
    if (this.bgmTimer !== null) clearInterval(this.bgmTimer);
    this.bgmTimer = null;
  }

  play(cue: Cue): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + 0.005;
    switch (cue.kind) {
      case 'playball':
        this.arpeggio([67, 72, 76, 79], t, 0.11, 0.06);
        break;
      case 'mitt':
        this.noise(t, 0.07, { filter: 'lowpass', freq: 900, gain: 0.35 });
        this.tone(140, t, 0.08, { type: 'sine', gain: 0.3, to: 80 });
        break;
      case 'hit':
        this.hit(cue, t);
        break;
      case 'hbp':
        this.tone(110, t, 0.14, { type: 'sine', gain: 0.45, to: 55 });
        this.noise(t, 0.09, { filter: 'lowpass', freq: 500, gain: 0.3 });
        if (cue.head) {
          // Seeing stars.
          for (let i = 0; i < 4; i++) this.tone(1900, t + 0.3 + i * 0.22, 0.09, { type: 'sine', gain: 0.05, to: 2500 });
        }
        break;
      case 'cheer':
        this.crowd(t, cue.big ? 2.8 : 1.5, cue.big ? 0.12 : 0.06);
        break;
      case 'homerun':
        this.arpeggio([72, 76, 79, 84], t + 0.1, 0.12, 0.07, 0.6);
        break;
      case 'strikeout':
        this.tone(620, t, 0.7, { type: 'sine', gain: 0.05, to: 210 });
        break;
      case 'call':
        if (cue.out) this.tone(330, t, 0.12, { type: 'triangle', gain: 0.06 });
        else {
          this.tone(660, t, 0.08, { type: 'triangle', gain: 0.05 });
          this.tone(880, t + 0.08, 0.1, { type: 'triangle', gain: 0.05 });
        }
        break;
      case 'change':
        this.arpeggio([60, 64, 67, 72, 67], t, 0.1, 0.05);
        break;
      case 'time':
        this.whistle(t);
        break;
      case 'request':
        this.tone(midi(84), t, 0.28, { type: 'sine', gain: 0.08 });
        this.tone(midi(79), t + 0.26, 0.4, { type: 'sine', gain: 0.08 });
        break;
      case 'verdict':
        if (cue.overturned) {
          this.arpeggio([76, 79, 84], t, 0.1, 0.06, 0.4);
          this.crowd(t, 2.2, 0.1);
        } else {
          this.tone(midi(67), t, 0.25, { type: 'triangle', gain: 0.06 });
          this.tone(midi(64), t + 0.22, 0.45, { type: 'triangle', gain: 0.06 });
        }
        break;
      case 'gameset':
        this.arpeggio([67, 72, 76, 79, 84], t, 0.16, 0.06, 0.8);
        break;
    }
  }

  private hit(cue: Extract<Cue, { kind: 'hit' }>, t: number): void {
    const level = (cue.bunt ? 0.35 : 0.55 + cue.quality * 0.45) * (cue.foul ? 0.75 : 1);
    if (cue.bat === 'fryingPan') {
      // ゴーン: a struck pan rings with inharmonic partials.
      [1, 2.32, 4.25, 6.63].forEach((m, i) => this.tone(380 * m, t, 1.4 / (1 + i * 0.6), { type: 'sine', gain: (0.22 * level) / (1 + i * 1.3) }));
      this.noise(t, 0.03, { filter: 'highpass', freq: 2000, gain: 0.2 * level });
      return;
    }
    if (cue.bat === 'leftTurnSign') {
      // カィーン: a steel sign plate.
      [1, 2.76, 5.4, 8.9].forEach((m, i) => this.tone(620 * m, t, 0.8 / (1 + i * 0.5), { type: 'sine', gain: (0.18 * level) / (1 + i) }));
      this.noise(t, 0.05, { filter: 'highpass', freq: 3000, gain: 0.3 * level });
      return;
    }
    // Dry wood: a sharp click and a few short, high, inharmonic knocks with almost no ring.
    // The torpedo bat sounds a little deeper; a bunt is a soft コッ.
    const pitch = cue.bat === 'torpedo' ? 0.88 : 1;
    const dur = cue.bunt ? 0.6 : 1;
    this.noise(t, 0.012, { filter: 'highpass', freq: 5000, gain: 0.3 * level, attack: 0.001 });
    this.noise(t, 0.035 * dur, { filter: 'bandpass', freq: 3100 * pitch, q: 1.4, gain: 0.55 * level, attack: 0.001 });
    [
      [1180, 0.07, 0.16],
      [1730, 0.05, 0.1],
      [2650, 0.035, 0.06],
    ].forEach(([f, d, g]) => this.tone(f! * pitch, t, d! * dur, { type: 'sine', gain: g! * level, attack: 0.001 }));
    this.tone(430 * pitch, t, 0.035 * dur, { type: 'sine', gain: 0.07 * level, attack: 0.001 });
  }

  private scheduleBgm(): void {
    const ctx = this.ctx;
    const dest = this.bgm;
    if (!ctx || !dest) return;
    while (this.bgmNext < ctx.currentTime + 0.35) {
      const step = this.bgmStep % MELODY.length;
      const t = this.bgmNext;
      const bar = Math.floor(step / 8);
      const chord = CHORDS[bar % CHORDS.length]!;
      if (step % 8 === 0) {
        for (const n of chord.pad) this.tone(midi(n), t, BGM_STEP_SEC * 8, { type: 'sine', gain: 0.012, attack: 0.25, dest });
      }
      if (step % 4 === 0) this.tone(midi(chord.bass), t, BGM_STEP_SEC * 3, { type: 'triangle', gain: 0.045, dest });
      const note = MELODY[step]!;
      if (note > 0) {
        this.tone(midi(note), t, 0.5, { type: 'sine', gain: 0.03, dest });
        this.tone(midi(note) * 2, t, 0.25, { type: 'triangle', gain: 0.006, dest });
      }
      this.bgmStep++;
      this.bgmNext += BGM_STEP_SEC;
    }
  }

  private tone(freq: number, start: number, dur: number, opts: ToneOptions = {}): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, start + dur);
    const peak = opts.gain ?? 0.1;
    const attack = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(dur, attack + 0.01));
    osc.connect(g).connect(opts.dest ?? this.sfx!);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  private noise(start: number, dur: number, opts: NoiseOptions = {}): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.filter ?? 'bandpass';
    f.frequency.value = opts.freq ?? 1000;
    f.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.2, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f).connect(g).connect(opts.dest ?? this.sfx!);
    src.start(start, Math.random() * 0.5);
    src.stop(start + dur + 0.05);
    return src;
  }

  /** The crowd rising and settling. */
  private crowd(start: number, dur: number, gain: number): void {
    this.noise(start, dur, { filter: 'bandpass', freq: 950, q: 0.5, gain, attack: dur * 0.25 });
    this.noise(start + 0.05, dur * 0.8, { filter: 'bandpass', freq: 2200, q: 0.8, gain: gain * 0.4, attack: dur * 0.2 });
  }

  private arpeggio(notes: number[], start: number, step: number, gain: number, hold = 0.25): void {
    notes.forEach((n, i) => {
      const last = i === notes.length - 1;
      const dur = last ? hold : step * 1.4;
      this.tone(midi(n), start + i * step, dur, { type: 'triangle', gain });
      this.tone(midi(n), start + i * step, dur, { type: 'square', gain: gain * 0.15 });
    });
  }

  /** The umpire's whistle for タイム. */
  private whistle(start: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const g = ctx.createGain();
    osc.frequency.value = 2300;
    lfo.frequency.value = 28;
    depth.gain.value = 70;
    lfo.connect(depth).connect(osc.frequency);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.045, start + 0.02);
    g.gain.setValueAtTime(0.045, start + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.connect(g).connect(this.sfx!);
    osc.start(start);
    lfo.start(start);
    osc.stop(start + 0.45);
    lfo.stop(start + 0.45);
  }
}
