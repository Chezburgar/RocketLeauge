/**
 * All game audio: synthesized SFX (no asset files needed), menu music player
 * (admin playlists from Supabase or a generative fallback track) and goal anthems.
 */

export interface Track {
  id: string;
  title: string;
  artist: string;
  url: string;
  duration?: number;
}

export type PlaylistMode = 'order' | 'shuffle' | 'radio';

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  anthem: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private anthemBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  volumes: Volumes = { master: 0.8, music: 0.6, sfx: 0.8, anthem: 0.9 };
  private anthemCache = new Map<string, Promise<AudioBuffer | null>>();
  private anthemSrc: AudioBufferSourceNode | null = null;
  private anthemGain: GainNode | null = null;
  private engine: { osc1: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; boostGain: GainNode; boostFilter: BiquadFilterNode } | null = null;
  private crowd: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  readonly music = new MusicPlayer(this);

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.anthemBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.anthemBus.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    this.music.onUnlock();
  }

  get musicOutput() {
    return this.musicBus;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.anthemBus.gain.setTargetAtTime(this.volumes.anthem, t, 0.05);
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number, when = 0, freqEnd?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, when = 0, bus?: GainNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus ?? this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ── sfx ──────────────────────────────────────────────────────────────
  ballHit(strength: number, distance = 0) {
    const k = Math.min(1, strength / 30) / (1 + distance * 0.04);
    if (k < 0.03) return;
    this.tone('sine', 150 + k * 80, 50, 0.25, 0.6 * k);
    this.noise(0.12 + k * 0.1, 'bandpass', 900 + k * 1500, 0.8, 0.9 * k);
    if (strength > 20) this.noise(0.4, 'highpass', 3000, 0.5, 0.25 * k);
  }
  bounce(strength: number, distance = 0) {
    const k = Math.min(1, strength / 20) / (1 + distance * 0.05);
    if (k < 0.05) return;
    this.tone('sine', 110, 45, 0.2, 0.4 * k);
    this.noise(0.08, 'lowpass', 600, 0.7, 0.4 * k);
  }
  jump() {
    this.noise(0.18, 'bandpass', 500, 1.5, 0.25, 0, 1400);
  }
  flip() {
    this.noise(0.3, 'bandpass', 1500, 1.2, 0.18, 0, 400);
  }
  pad(big: boolean) {
    this.tone('triangle', big ? 660 : 880, big ? 1320 : 1320, big ? 0.35 : 0.15, big ? 0.25 : 0.12);
    if (big) this.tone('sine', 990, 1980, 0.3, 0.15, 0.05);
  }
  demo(distance = 0) {
    const k = 1 / (1 + distance * 0.04);
    this.noise(1.0, 'lowpass', 1800, 0.5, 1.0 * k, 0, 120);
    this.tone('sawtooth', 90, 30, 0.6, 0.4 * k);
    this.noise(0.25, 'highpass', 2500, 0.6, 0.35 * k);
  }
  bump(strength: number) {
    this.noise(0.15, 'lowpass', 900, 0.9, Math.min(0.7, strength / 25));
  }
  countdown(n: number) {
    this.tone('square', 660, 660, 0.18, 0.15);
    if (n === 0) this.tone('square', 1320, 1320, 0.4, 0.18);
  }
  go() {
    this.tone('square', 1320, 1320, 0.45, 0.18);
    this.tone('sawtooth', 660, 1320, 0.3, 0.06);
  }
  horn() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const f of [220, 277, 330, 440]) this.tone('sawtooth', f, f, 1.6, 0.09);
    this.noise(2.5, 'bandpass', 1200, 0.4, 0.5, 0.05);
  }
  click() {
    this.tone('square', 1200, 900, 0.05, 0.05);
  }
  hover() {
    this.tone('sine', 1800, 1800, 0.03, 0.025);
  }
  whoosh() {
    this.noise(0.35, 'bandpass', 400, 1, 0.25, 0, 2400);
  }

  // ── crowd ambience ─────────────────────────────────────────────────
  startCrowd() {
    const ctx = this.ctx;
    if (!ctx || this.crowd) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start();
    this.crowd = { gain, filter };
    gain.gain.setTargetAtTime(0.06, ctx.currentTime, 1);
  }
  stopCrowd() {
    if (!this.ctx || !this.crowd) return;
    this.crowd.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
  }
  cheer(amount: number, dur = 3) {
    const ctx = this.ctx;
    if (!ctx || !this.crowd) return;
    const t = ctx.currentTime;
    const g = this.crowd.gain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.06 + 0.3 * amount, t, 0.15);
    g.setTargetAtTime(0.06, t + dur, 1.2);
    this.crowd.filter.frequency.setTargetAtTime(700 + 900 * amount, t, 0.2);
    this.crowd.filter.frequency.setTargetAtTime(700, t + dur, 1.2);
  }

  // ── engine (local car) ─────────────────────────────────────────────
  startEngine() {
    const ctx = this.ctx;
    if (!ctx || this.engine) return;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(this.sfxBus);
    osc1.start();
    osc2.start();
    const nsrc = ctx.createBufferSource();
    nsrc.buffer = this.noiseBuf;
    nsrc.loop = true;
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'bandpass';
    boostFilter.frequency.value = 900;
    boostFilter.Q.value = 0.8;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0;
    nsrc.connect(boostFilter).connect(boostGain).connect(this.sfxBus);
    nsrc.start();
    this.engine = { osc1, osc2, filter, gain, boostGain, boostFilter };
  }
  updateEngine(speed: number, throttle: number, boosting: boolean, onGround: boolean, active: boolean) {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    const k = Math.min(1, speed / 23);
    const f = 45 + k * 110 + Math.abs(throttle) * 12;
    e.osc1.frequency.setTargetAtTime(f, t, 0.05);
    e.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    e.filter.frequency.setTargetAtTime(250 + k * 1300 + Math.abs(throttle) * 300, t, 0.05);
    e.gain.gain.setTargetAtTime(active ? 0.035 + k * 0.05 : 0, t, 0.08);
    e.boostGain.gain.setTargetAtTime(active && boosting ? 0.22 : 0, t, 0.04);
    e.boostFilter.frequency.setTargetAtTime(boosting ? 700 + k * 900 : 600, t, 0.1);
  }
  stopEngine() {
    if (!this.engine || !this.ctx) return;
    this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.engine.boostGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }

  // ── anthems ────────────────────────────────────────────────────────
  loadAnthem(url: string): Promise<AudioBuffer | null> {
    let p = this.anthemCache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((buf) => (this.ctx ? this.ctx.decodeAudioData(buf) : null))
        .catch(() => null);
      this.anthemCache.set(url, p);
    }
    return p;
  }

  async playAnthem(url: string, maxSeconds = 12) {
    if (!this.ctx) return;
    this.stopAnthem();
    const buf = await this.loadAnthem(url);
    if (!buf || !this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const dur = Math.min(buf.duration, maxSeconds);
    g.gain.setValueAtTime(1, t);
    g.gain.setValueAtTime(1, t + Math.max(0, dur - 1.2));
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(g).connect(this.anthemBus);
    src.start(t);
    src.stop(t + dur + 0.1);
    this.anthemSrc = src;
    this.anthemGain = g;
    this.music.duck(true);
    src.onended = () => {
      if (this.anthemSrc === src) {
        this.anthemSrc = null;
        this.music.duck(false);
      }
    };
  }

  stopAnthem() {
    if (this.anthemSrc && this.ctx) {
      const g = this.anthemGain!;
      g.gain.cancelScheduledValues(this.ctx.currentTime);
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      try {
        this.anthemSrc.stop(this.ctx.currentTime + 0.4);
      } catch {
        /* already stopped */
      }
      this.anthemSrc = null;
      this.music.duck(false);
    }
  }
}

/** Plays the menu playlist (or a generative fallback track) through the music bus. */
export class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private node: MediaElementAudioSourceNode | null = null;
  private fade: GainNode | null = null;
  private tracks: Track[] = [];
  private order: number[] = [];
  private idx = 0;
  private mode: PlaylistMode = 'order';
  private epoch = 0;
  private active = false;
  private ducked = false;
  private gen: GenerativeTrack | null = null;
  playlistName = '';
  current: Track | null = null;
  onTrackChange: ((t: Track | null) => void) | null = null;

  constructor(private audio: AudioEngine) {}

  onUnlock() {
    if (this.active) this.start();
  }

  setPlaylist(name: string, tracks: Track[], mode: PlaylistMode, epochMs: number) {
    const changed = JSON.stringify(tracks.map((t) => t.url)) !== JSON.stringify(this.tracks.map((t) => t.url)) || mode !== this.mode;
    this.playlistName = name;
    this.tracks = tracks;
    this.mode = mode;
    this.epoch = epochMs;
    if (!changed) return;
    this.order = tracks.map((_, i) => i);
    if (mode === 'shuffle') {
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
    this.idx = mode === 'order' ? 0 : 0;
    if (this.active) {
      this.stopCurrent();
      this.playNext(true);
    }
  }

  /** Start / resume menu music. */
  start() {
    this.active = true;
    const ctx = this.audio.ctx;
    if (!ctx) return;
    if (!this.fade) {
      this.fade = ctx.createGain();
      this.fade.connect(this.audio.musicOutput);
    }
    this.fade.gain.cancelScheduledValues(ctx.currentTime);
    this.fade.gain.setTargetAtTime(this.ducked ? 0.15 : 1, ctx.currentTime, 0.4);
    if (this.el && !this.el.ended && this.el.src) {
      void this.el.play().catch(() => {});
      return;
    }
    if (this.gen) {
      this.gen.resume();
      return;
    }
    this.playNext(true);
  }

  /** Fade out (entering a match). */
  stop() {
    this.active = false;
    const ctx = this.audio.ctx;
    if (!ctx || !this.fade) return;
    this.fade.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
    setTimeout(() => {
      if (!this.active) {
        this.el?.pause();
        this.gen?.pause();
      }
    }, 2000);
  }

  duck(on: boolean) {
    this.ducked = on;
    const ctx = this.audio.ctx;
    if (!ctx || !this.fade || !this.active) return;
    this.fade.gain.setTargetAtTime(on ? 0.15 : 1, ctx.currentTime, 0.3);
  }

  skip() {
    if (!this.tracks.length) return;
    this.stopCurrent();
    this.playNext(false);
  }

  private stopCurrent() {
    if (this.el) {
      this.el.pause();
      this.el.src = '';
    }
    if (this.gen) {
      this.gen.stop();
      this.gen = null;
    }
  }

  private playNext(first: boolean) {
    const ctx = this.audio.ctx;
    if (!ctx || !this.fade) return;
    if (!this.tracks.length) {
      // generative fallback
      if (!this.gen) this.gen = new GenerativeTrack(ctx, this.fade);
      this.gen.start();
      this.current = { id: 'gen', title: 'Main Theme (generative)', artist: 'Boost League', url: '' };
      this.onTrackChange?.(this.current);
      return;
    }
    let seek = 0;
    if (this.mode === 'radio') {
      // everyone hears the same thing: position derived from a shared clock
      const durations = this.tracks.map((t) => t.duration || 180);
      const total = durations.reduce((a, b) => a + b, 0);
      let pos = (((Date.now() - this.epoch) / 1000) % total + total) % total;
      let i = 0;
      while (pos > durations[i]) {
        pos -= durations[i];
        i++;
      }
      this.idx = i;
      seek = pos;
    } else if (!first) {
      this.idx = (this.idx + 1) % this.order.length;
    }
    const track = this.tracks[this.mode === 'radio' ? this.idx : this.order[this.idx]];
    if (!this.el) {
      this.el = new Audio();
      this.el.crossOrigin = 'anonymous';
      this.el.preload = 'auto';
      this.node = ctx.createMediaElementSource(this.el);
      this.node.connect(this.fade);
      this.el.addEventListener('ended', () => {
        if (this.active) this.playNext(false);
      });
      this.el.addEventListener('error', () => {
        // skip broken tracks
        setTimeout(() => this.active && this.tracks.length > 1 && this.playNext(false), 800);
      });
    }
    this.el.src = track.url;
    if (seek > 0) {
      const s = seek;
      this.el.addEventListener('loadedmetadata', () => (this.el!.currentTime = Math.min(s, (this.el!.duration || s) - 1)), { once: true });
    }
    void this.el.play().catch(() => {});
    this.current = track;
    this.onTrackChange?.(track);
  }
}

/** A small generative synthwave loop used when no admin playlist is configured. */
class GenerativeTrack {
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private out: GainNode;
  private bpm = 104;
  // Am – F – C – G
  private chords = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 52, 55],
    [55, 59, 62],
  ];
  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.55;
    const delay = ctx.createDelay();
    delay.delayTime.value = (60 / this.bpm) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    this.out.connect(dest);
    this.out.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(dest);
  }
  private hz(n: number) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }
  start() {
    if (this.timer !== null) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 50);
  }
  resume() {
    this.start();
  }
  pause() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  stop() {
    this.pause();
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }
  private note(type: OscillatorType, freq: number, t: number, dur: number, gain: number, cutoff: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.3), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  private drum(t: number, kind: 'kick' | 'hat' | 'snare') {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.3);
    } else {
      const len = kind === 'hat' ? 0.05 : 0.18;
      const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const s = ctx.createBufferSource();
      s.buffer = b;
      const f = ctx.createBiquadFilter();
      f.type = kind === 'hat' ? 'highpass' : 'bandpass';
      f.frequency.value = kind === 'hat' ? 7000 : 1800;
      const g = ctx.createGain();
      g.gain.value = kind === 'hat' ? 0.08 : 0.22;
      s.connect(f).connect(g).connect(this.out);
      s.start(t);
    }
  }
  private schedule() {
    const spb = 60 / this.bpm / 4; // sixteenth
    while (this.nextTime < this.ctx.currentTime + 0.2) {
      const s = this.step % 64;
      const bar = Math.floor(s / 16);
      const chord = this.chords[bar];
      const t = this.nextTime;
      const inBar = s % 16;
      if (inBar === 0) for (const n of chord) this.note('sawtooth', this.hz(n), t, spb * 16, 0.035, 1400);
      if (inBar % 4 === 0) this.note('triangle', this.hz(chord[0] - 24), t, spb * 3, 0.16, 600);
      if (inBar % 2 === 0) {
        const arp = [0, 1, 2, 1, 2, 0, 2, 1];
        const n = chord[arp[(inBar / 2) % 8]] + 12 + (this.step % 128 >= 64 ? 12 : 0);
        this.note('square', this.hz(n), t, spb * 1.6, 0.03, 2600);
      }
      if (this.step >= 32) {
        if (inBar % 4 === 0) this.drum(t, 'kick');
        if (inBar % 8 === 4) this.drum(t, 'snare');
        if (inBar % 2 === 1) this.drum(t, 'hat');
      }
      this.nextTime += spb;
      this.step++;
    }
  }
}

export const audio = new AudioEngine();
