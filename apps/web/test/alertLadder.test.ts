/**
 * The app's own notification ladder — the same three rungs the proxy pushes.
 *
 * Two systems can reach one phone: the browser's local notification and the
 * pushed one. They have to say the same thing at the same moments, so this
 * tests the app half against the same cases `push-alerts.test.js` runs on the
 * proxy half.
 *
 * What it exists to stop coming back: a message when a setup was ADOPTED, and
 * one when price REACHED the level claiming the trade would open next candle.
 * The second stopped being true when ‹A10› and ‹A11› arrived, and both kept
 * arriving long after the rules that justified them were gone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const shown: Array<{ title: string; body: string }> = [];

vi.mock('../lib/sounds', () => ({
  playCallSound: vi.fn(),
  playPutSound: vi.fn(),
  playNewSignalSound: vi.fn(),
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

// Alerts have to be ON, or `notify` returns before doing anything — which is
// the switch the user owns and every one of these cases sits behind.
store.set('alerts_enabled', '1');

class FakeNotification {
  static permission = 'granted';
  constructor(title: string, opts: { body: string }) {
    shown.push({ title, body: opts.body });
  }
}

// `webNotificationsAvailable` asks for `'Notification' in window`, so a bare
// global is not enough in this environment — the module has to find it on
// `window` exactly as a browser would present it.
vi.stubGlobal('Notification', FakeNotification);
vi.stubGlobal('window', { Notification: FakeNotification });

const { notifyStage, resetLadders, ALERT_NEAR, ALERT_VERY_CLOSE, ALERT_FIRED } = await import(
  '../lib/signalNotify'
);

const at = (percent: number, extra: { setupKey?: string | null; fired?: boolean } = {}) =>
  notifyStage({
    symbol: 'EURUSD',
    name: 'EUR/USD',
    setupKey: 'a:b',
    percent,
    ...extra,
  });

beforeEach(() => {
  shown.length = 0;
  resetLadders();
});

describe('one setup, one ladder', () => {
  it('sends 96 once, and says nothing more inside the rung', () => {
    expect(at(96.4)).toBe(ALERT_NEAR);
    for (const p of [96.5, 97.0, 97.4, 97.9]) expect(at(p)).toBeNull();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.body).toContain('إشارة محتملة قريبًا');
    expect(shown[0]!.body).toContain('EUR/USD');
    expect(shown[0]!.body).toContain('96.4%');
  });

  it('sends 98 once, and says nothing more up to the close', () => {
    at(96.2);
    expect(at(98.1)).toBe(ALERT_VERY_CLOSE);
    for (const p of [98.4, 99.1, 99.9, 99.99]) expect(at(p)).toBeNull();
    expect(shown).toHaveLength(2);
    expect(shown[1]!.body).toContain('قريب جدًا من إصدار إشارة');
  });

  it('is exactly three messages for a full climb', () => {
    for (const p of [95.4, 96.1, 96.8, 97.9, 98.2, 99.4, 99.99]) at(p);
    at(100, { fired: true });
    expect(shown.map((s) => s.body.slice(0, 12))).toEqual([
      'إشارة محتملة'.slice(0, 12),
      'قريب جدًا من'.slice(0, 12),
      '🚨 اتفتحت إش'.slice(0, 12),
    ]);
  });
});

describe('the jump nobody sees coming', () => {
  it('sends only the signal when a candle goes from below 96 straight to fired', () => {
    for (const p of [88, 92.5, 95.9]) expect(at(p)).toBeNull();
    expect(at(100, { fired: true })).toBe(ALERT_FIRED);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.body).toContain('🚨');
  });

  it('never back-fills the rungs it skipped', () => {
    at(100, { fired: true });
    for (const p of [96.5, 98.7, 99.2]) expect(at(p)).toBeNull();
    expect(shown).toHaveLength(1);
  });

  it('does not step back down when the reading falls', () => {
    at(98.3);
    expect(at(96.4)).toBeNull();
    expect(at(97.1)).toBeNull();
    expect(shown).toHaveLength(1);
  });
});

describe('once, whatever the page does', () => {
  it('survives the reading arriving every second', () => {
    for (let i = 0; i < 60; i++) at(96.7);
    expect(shown).toHaveLength(1);
  });

  it('survives a reload mid-opportunity', async () => {
    at(96.5);
    at(98.5);
    expect(shown).toHaveLength(2);

    // A reload: the module's state is gone, `localStorage` is not.
    vi.resetModules();
    const fresh = await import('../lib/signalNotify');
    fresh.notifyStage({ symbol: 'EURUSD', name: 'EUR/USD', setupKey: 'a:b', percent: 96.6 });
    fresh.notifyStage({ symbol: 'EURUSD', name: 'EUR/USD', setupKey: 'a:b', percent: 98.6 });
    expect(shown, 'a refresh must not announce it again').toHaveLength(2);
  });

  it('starts a fresh ladder for a genuinely new setup', () => {
    at(96.5);
    at(98.5);
    expect(at(96.1, { setupKey: 'c:d' })).toBe(ALERT_NEAR);
    expect(at(98.9, { setupKey: 'c:d' })).toBe(ALERT_VERY_CLOSE);
    expect(shown).toHaveLength(4);
  });

  it('forgets a setup that died without firing', () => {
    at(96.5);
    at(0, { setupKey: null });
    // The same key coming back is a new opportunity as far as the ladder knows,
    // which is right: the engine only re-adopts a swing it had let go.
    expect(at(96.5)).toBe(ALERT_NEAR);
  });
});

describe('what never produces a message', () => {
  it('says nothing below 96', () => {
    for (const p of [0, 42, 89.9, 90, 94.9, 95.99]) expect(at(p)).toBeNull();
    expect(shown).toHaveLength(0);
  });

  it('says nothing for a pair with no setup', () => {
    expect(at(99, { setupKey: null })).toBeNull();
    expect(shown).toHaveLength(0);
  });

  it('says nothing at all when alerts are switched off', () => {
    store.set('alerts_enabled', '0');
    at(96.5);
    at(100, { fired: true });
    expect(shown).toHaveLength(0);
    store.set('alerts_enabled', '1');
  });

  it('never claims a trade in the two warnings', () => {
    at(96.5);
    at(98.5);
    for (const s of shown) {
      expect(s.body).not.toContain('اتفتحت');
      expect(s.title).toContain('فرصة');
    }
  });
});
