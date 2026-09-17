/**
 * The pause state, and the one condition allowed to raise it.
 *
 * It tells the user signals are paused. Raising it for a proxy outage, a slow
 * price feed or a reconnecting socket would say that falsely — so most of these
 * tests are about what must NOT turn it on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isQuotaActive, noteHubResponse, onQuotaChange, reportQuota, reportResumed,
  resetQuotaForTests, setQuotaProbe,
} from '../lib/quota.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const QUOTA = { error: 'daily limit reached', code: 'd1_quota', limit: 'write', resumes_at: 0 };

beforeEach(() => {
  resetQuotaForTests();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('what raises it', () => {
  it('a 503 carrying the quota code', async () => {
    expect(await noteHubResponse(json(503, { ...QUOTA, resumes_at: Date.now() + 1000 }))).toBe(true);
    expect(isQuotaActive()).toBe(true);
  });
});

describe('what must NOT raise it', () => {
  it.each([
    ['a 503 with no code — an overloaded or unreachable hub', json(503, { error: 'x' })],
    ['a 503 with a different code', json(503, { code: 'something_else' })],
    ['a 500 — a failed query', json(500, { error: 'query failed' })],
    ['a 429 — the candle shed', json(429, { error: 'daily write budget reserved' })],
    ['a 401 — a bad secret', json(401, { error: 'bad credential' })],
    ['a 403 — a refused table', json(403, { error: 'refused' })],
    ['a 502 from a proxy in front', new Response('<html>Bad Gateway</html>', { status: 502 })],
    ['a 503 whose body is not JSON', new Response('Service Unavailable', { status: 503 })],
    ['a 200', json(200, { rows: [] })],
  ])('%s', async (_label, res) => {
    expect(await noteHubResponse(res)).toBe(false);
    expect(isQuotaActive()).toBe(false);
  });

  it('leaves the body readable for the caller', async () => {
    // noteHubResponse reads a clone; the caller still wants the original.
    const res = json(503, { ...QUOTA, resumes_at: Date.now() + 1000 });
    await noteHubResponse(res);
    await expect(res.json()).resolves.toMatchObject({ code: 'd1_quota' });
  });
});

describe('telling the screen', () => {
  it('announces the change once, not on every failed read', () => {
    const seen: boolean[] = [];
    onQuotaChange((a) => seen.push(a));
    reportQuota(Date.now() + 1000);
    reportQuota(Date.now() + 1000);
    reportQuota(Date.now() + 1000);
    expect(seen).toEqual([true]);
  });

  it('announces the end once', () => {
    const seen: boolean[] = [];
    onQuotaChange((a) => seen.push(a));
    reportQuota(Date.now() + 1000);
    reportResumed();
    reportResumed();
    expect(seen).toEqual([true, false]);
  });

  it('ignores a resume it was never told to pause for', () => {
    const seen: boolean[] = [];
    onQuotaChange((a) => seen.push(a));
    reportResumed();
    expect(seen).toEqual([]);
  });
});

describe('ending without a reload', () => {
  it('does not ask before the reset — the answer is known', async () => {
    const probe = vi.fn(async () => true);
    setQuotaProbe(probe);
    reportQuota(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(probe).not.toHaveBeenCalled();
    expect(isQuotaActive()).toBe(true);
  });

  it('asks shortly after the reset, and clears on an answer', async () => {
    const probe = vi.fn(async () => true);
    setQuotaProbe(probe);
    reportQuota(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(60_000 + 31_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(isQuotaActive()).toBe(false);
  });

  it('keeps asking every two minutes while still refused, and no faster', async () => {
    // Every request reaches the Worker, which has its own daily limit.
    // Retrying fast through a lockout spends that too.
    const probe = vi.fn(async () => false);
    setQuotaProbe(probe);
    // Reset at t=1s, first check at t=31s, the retry two minutes later: t=151s.
    reportQuota(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(32_000);          // t=32s
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(118_000);         // t=150s — not yet
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);            // t=152s
    expect(probe).toHaveBeenCalledTimes(2);
    expect(isQuotaActive()).toBe(true);
  });

  it('stops asking once the socket says it is over', async () => {
    const probe = vi.fn(async () => false);
    setQuotaProbe(probe);
    reportQuota(Date.now() + 1000);
    reportResumed();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probe).not.toHaveBeenCalled();
  });

  it('survives a probe that throws', async () => {
    setQuotaProbe(async () => { throw new Error('offline'); });
    reportQuota(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(isQuotaActive()).toBe(true);
  });
});
