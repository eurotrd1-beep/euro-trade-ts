/**
 * One list of chosen pairs — Phase 1.
 *
 * There used to be two answers to "which pairs am I following": a private list
 * inside the notification code, and a watch loop that swept the whole catalogue
 * regardless. A mismatch between them shows up nowhere — an alert about a
 * market nobody picked, or silence about the one they did — so the list is
 * single-sourced here, and these pin the three things that made it subtle.
 *
 * Empty is not "everything". A user who has chosen nothing wants nothing yet,
 * and reading that as "all of them" is how somebody ends up with 89 alert
 * streams they never asked for.
 *
 * The old key has to be carried over. Someone who had already picked pairs for
 * notifications must not arrive to an empty selection and a dead button.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { legacyWantedEverything, loadWatched, saveWatched, NOISY_SELECTION } from '@/lib/watchedPairs';

const LEGACY = 'push_symbols';

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  return store;
}

describe('the chosen pairs', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installStorage(); });

  it('is empty before anything is chosen', () => {
    expect(loadWatched('acct')).toEqual([]);
  });

  it('remembers what was chosen', () => {
    saveWatched('acct', ['EURUSD_otc', 'XAUUSD_otc']);
    expect(loadWatched('acct')).toEqual(['EURUSD_otc', 'XAUUSD_otc']);
  });

  it('stores one copy of each, in a stable order', () => {
    // So "did the selection change" is a string comparison rather than a set
    // comparison, whatever order the picker collected them in.
    saveWatched('acct', ['GBPUSD_otc', 'EURUSD_otc', 'GBPUSD_otc']);
    expect(loadWatched('acct')).toEqual(['EURUSD_otc', 'GBPUSD_otc']);
  });

  it('keeps two accounts on one device apart', () => {
    saveWatched('one', ['EURUSD_otc']);
    saveWatched('two', ['XAUUSD_otc']);
    expect(loadWatched('one')).toEqual(['EURUSD_otc']);
    expect(loadWatched('two')).toEqual(['XAUUSD_otc']);
  });

  it('keeps an empty choice empty rather than treating it as everything', () => {
    // The distinction the disabled generate button rests on.
    saveWatched('acct', []);
    expect(loadWatched('acct')).toEqual([]);
  });

  it('carries over a list the notifications button had stored', () => {
    store.set(LEGACY, JSON.stringify(['EURUSD_otc', 'GBPUSD_otc']));
    expect(loadWatched('acct')).toEqual(['EURUSD_otc', 'GBPUSD_otc']);
  });

  it('reports the old "every pair" so the caller can expand it', () => {
    // `'all'` cannot be expanded in the store itself — it does not know the
    // catalogue — so it comes back empty and is flagged instead.
    store.set(LEGACY, 'all');
    expect(loadWatched('acct')).toEqual([]);
    expect(legacyWantedEverything()).toBe(true);
  });

  it('retires the old key once a choice is saved', () => {
    // Otherwise a device that syncs storage migrates it a second time and
    // overwrites a selection the user has since changed.
    store.set(LEGACY, JSON.stringify(['EURUSD_otc']));
    saveWatched('acct', ['XAUUSD_otc']);
    expect(store.has(LEGACY)).toBe(false);
    expect(loadWatched('acct')).toEqual(['XAUUSD_otc']);
  });

  it('prefers its own list over the old one', () => {
    saveWatched('acct', ['XAUUSD_otc']);
    store.set(LEGACY, JSON.stringify(['EURUSD_otc']));
    expect(loadWatched('acct')).toEqual(['XAUUSD_otc']);
  });

  it('treats unreadable storage as no choice, not as a crash', () => {
    store.set('watched_pairs:acct', '{not json');
    expect(loadWatched('acct')).toEqual([]);
  });

  it('drops junk entries rather than watching them', () => {
    store.set('watched_pairs:acct', JSON.stringify(['EURUSD_otc', 42, null, '']));
    expect(loadWatched('acct')).toEqual(['EURUSD_otc']);
  });

  it('has a threshold worth warning about', () => {
    // Not a performance limit — 89 pairs evaluate in a fraction of a
    // millisecond. A count of separate alerts arriving on a phone.
    expect(NOISY_SELECTION).toBeGreaterThan(0);
    expect(NOISY_SELECTION).toBeLessThan(89);
  });
});
