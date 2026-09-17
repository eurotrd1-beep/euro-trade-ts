/**
 * Sound and notifications stay quiet while the quota pause is up.
 *
 * The signals column says "signals are paused" during a D1 lockout, while the
 * engine — which runs in the browser from proxy candles — keeps producing
 * signals behind it. A sound or a notification under that cover would say the
 * opposite of the screen. So both are withheld at the one place each passes
 * through, and the engine is not touched.
 *
 * The tests check the gate and its release, and that nothing is queued: a
 * notification about a moment in the lockout, delivered at midnight, would be
 * wrong on arrival.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shown: Array<{ title: string; body?: string }> = [];
const tones: number[] = [];

class FakeNotification {
  static permission = 'granted';
  constructor(title: string, opts?: { body?: string }) { shown.push({ title, body: opts?.body }); }
}

/** Just enough Web Audio for `play()` to reach the point of making a sound. */
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume(): Promise<void> { return Promise.resolve(); }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
      connect() {},
    };
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: (f: number) => { tones.push(f); } },
      connect() {},
      start() {},
      stop() {},
    };
  }
}

beforeEach(() => {
  shown.length = 0;
  tones.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const store = new Map<string, string>([['alerts_enabled', '1']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.resetModules();
});

afterEach(() => { vi.unstubAllGlobals(); });

const load = async () => {
  const quota = await import('../lib/quota.js');
  quota.resetQuotaForTests();
  const notifyMod = await import('../lib/signalNotify.js');
  const sounds = await import('../lib/sounds.js');
  return { quota, notifyMod, sounds };
};

describe('notifications', () => {
  it('are shown normally', async () => {
    const { notifyMod } = await load();
    notifyMod.notify('EUR/USD', 'CALL');
    expect(shown).toHaveLength(1);
  });

  it('are withheld during the lockout', async () => {
    const { quota, notifyMod } = await load();
    quota.reportQuota(Date.now() + 3_600_000);
    notifyMod.notify('EUR/USD', 'CALL');
    expect(shown).toHaveLength(0);
  });

  it('come back when it ends — and nothing from the lockout is replayed', async () => {
    const { quota, notifyMod } = await load();
    quota.reportQuota(Date.now() + 3_600_000);
    notifyMod.notify('during', 'lockout');
    quota.reportResumed();
    expect(shown).toHaveLength(0);
    notifyMod.notify('after', 'lockout');
    expect(shown.map((n) => n.title)).toEqual(['after']);
  });

  it('still respect the user switching them off, lockout or not', async () => {
    const { notifyMod } = await load();
    notifyMod.setAlertsEnabled(false);
    notifyMod.notify('EUR/USD', 'CALL');
    expect(shown).toHaveLength(0);
  });
});

describe('sounds', () => {
  it('play normally', async () => {
    const { sounds } = await load();
    sounds.playCallSound();
    expect(tones.length).toBeGreaterThan(0);
  });

  it.each(['playNewSignalSound', 'playCallSound', 'playPutSound', 'playWinSound', 'playLossSound'] as const)(
    '%s is silent during the lockout',
    async (name) => {
      const { quota, sounds } = await load();
      quota.reportQuota(Date.now() + 3_600_000);
      sounds[name]();
      expect(tones).toHaveLength(0);
    },
  );

  it('play again when it ends', async () => {
    const { quota, sounds } = await load();
    quota.reportQuota(Date.now() + 3_600_000);
    quota.reportResumed();
    sounds.playPutSound();
    expect(tones.length).toBeGreaterThan(0);
  });
});
