'use client';

/**
 * Signal sounds — ported from the Web Audio synthesisers in signal_engine.dart
 * (`_playNewSignalSound` :7357, `_playWinSound` :7394, `_playLossSound` :7423,
 * `_playActivateSound` :7452, `_playCallSound` :7477, `_playPutSound` :7503).
 *
 * Every oscillator type, frequency, gain and duration is copied exactly, so a
 * signal sounds the same as it did in the Flutter build.
 *
 * One deliberate difference: the Dart version builds a NEW `AudioContext` for
 * every beep. Browsers cap a page at roughly six live contexts and never free
 * them, so after a handful of signals the sounds simply stop. Here a single
 * context is created once and reused.
 */

let ctx: AudioContext | null = null;

type Ctor = typeof AudioContext;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx !== null) return ctx;
  try {
    const Ctx: Ctor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Browsers start the audio context suspended until the page has been
 * interacted with. Call this from a click handler — pressing the signal button
 * is the natural place — so the first sound is not swallowed.
 */
export function unlockAudio(): void {
  const c = audioContext();
  if (c && c.state === 'suspended') void c.resume();
}

interface Step {
  /** Seconds after the note starts. */
  at: number;
  hz: number;
  /** `linearRampToValueAtTime` instead of a step change. */
  ramp?: 'linear' | 'exponential';
}

interface Note {
  type: OscillatorType;
  steps: Step[];
  gain: number;
  duration: number;
}

function play(notes: Note[]): void {
  const c = audioContext();
  if (c === null) return;
  if (c.state === 'suspended') void c.resume();

  try {
    const t0 = c.currentTime;
    const gainNode = c.createGain();
    // The Dart code shares one gain node across the oscillators of a note.
    const longest = Math.max(...notes.map((n) => n.duration));
    gainNode.gain.setValueAtTime(notes[0]!.gain, t0);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + longest);
    gainNode.connect(c.destination);

    for (const note of notes) {
      const osc = c.createOscillator();
      osc.type = note.type;
      for (const s of note.steps) {
        if (s.ramp === 'exponential') osc.frequency.exponentialRampToValueAtTime(s.hz, t0 + s.at);
        else if (s.ramp === 'linear') osc.frequency.linearRampToValueAtTime(s.hz, t0 + s.at);
        else osc.frequency.setValueAtTime(s.hz, t0 + s.at);
      }
      osc.connect(gainNode);
      osc.start();
      osc.stop(t0 + note.duration);
    }
  } catch {
    // Audio is a nicety; never let it break the trading screen.
  }
}

/** `_playNewSignalSound` — two oscillators sweeping up together. */
export function playNewSignalSound(): void {
  play([
    {
      type: 'triangle',
      gain: 0.1,
      duration: 0.35,
      steps: [
        { at: 0, hz: 523.25 }, // C5
        { at: 0.15, hz: 783.99, ramp: 'exponential' }, // G5
      ],
    },
    {
      type: 'sine',
      gain: 0.1,
      duration: 0.35,
      steps: [
        { at: 0.05, hz: 659.25 }, // E5
        { at: 0.25, hz: 987.77, ramp: 'exponential' }, // B5
      ],
    },
  ]);
}

/** `_playWinSound` — a rising three-note chime. */
export function playWinSound(): void {
  play([
    {
      type: 'sine',
      gain: 0.12,
      duration: 0.5,
      steps: [
        { at: 0, hz: 659.25 }, // E5
        { at: 0.1, hz: 880.0 }, // A5
        { at: 0.2, hz: 1318.51 }, // E6
      ],
    },
  ]);
}

/** `_playLossSound` — a falling sawtooth. */
export function playLossSound(): void {
  play([
    {
      type: 'sawtooth',
      gain: 0.1,
      duration: 0.45,
      steps: [
        { at: 0, hz: 220.0 }, // A3
        { at: 0.4, hz: 110.0, ramp: 'linear' }, // A2
      ],
    },
  ]);
}

/** `_playActivateSound` — the soft two-note blip when monitoring starts. */
export function playActivateSound(): void {
  play([
    {
      type: 'sine',
      gain: 0.07,
      duration: 0.22,
      steps: [
        { at: 0, hz: 440.0 }, // A4
        { at: 0.09, hz: 587.33 }, // D5
      ],
    },
  ]);
}

/** `_playCallSound` — bright, rising, positive. */
export function playCallSound(): void {
  play([
    {
      type: 'triangle',
      gain: 0.14,
      duration: 0.5,
      steps: [
        { at: 0, hz: 523.25 }, // C5
        { at: 0.11, hz: 659.25 }, // E5
        { at: 0.22, hz: 880.0 }, // A5
      ],
    },
  ]);
}

/** `_playPutSound` — falling counterpart. */
export function playPutSound(): void {
  play([
    {
      type: 'sawtooth',
      gain: 0.12,
      duration: 0.5,
      steps: [
        { at: 0, hz: 440.0 }, // A4
        { at: 0.11, hz: 349.23 }, // F4
        { at: 0.22, hz: 261.63 }, // C4
      ],
    },
  ]);
}
