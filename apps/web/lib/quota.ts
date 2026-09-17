'use client';

/**
 * Whether D1's daily quota is spent, as far as this app knows.
 *
 * ── THE ONE CONDITION THIS IS ABOUT ────────────────────────────────────────
 *
 * The free plan's daily read or write limit is used up, and every D1 query is
 * refused until 00:00 UTC. Not a proxy outage, not a price-feed problem, not a
 * slow or reconnecting socket — those have their own indicators and must never
 * raise this one, because this one tells the user signals are paused.
 *
 * So nothing here guesses. It is set by exactly two things, both of which the
 * hub only produces after matching Cloudflare's documented quota message:
 *
 *   a response carrying `code: 'd1_quota'`
 *   a `quota` message on the live socket
 *
 * An unrecognised failure produces neither, and this stays off.
 *
 * ── HOW IT ENDS WITHOUT A RELOAD ───────────────────────────────────────────
 *
 * The hub checks D1 every five minutes during a lockout and broadcasts
 * `resumed` the first time it answers. That is the normal path.
 *
 * The fallback is here: at the reset time plus thirty seconds, this makes one
 * cheap read of its own, and keeps trying every two minutes while the answer is
 * still the quota. It covers an app whose socket was down when `resumed` went
 * out — a phone waking up, a tab in the background.
 *
 * ── AND WHY IT STOPS ASKING IN BETWEEN ─────────────────────────────────────
 *
 * Because every request still reaches the Worker, and the Worker has its own
 * daily limit, separate from D1's. An app that kept retrying through a lockout
 * would spend that budget on answers it already knows, and the two limits
 * running out one after the other is a much longer outage than one.
 */

type Listener = (active: boolean) => void;

const RETRY_MS = 2 * 60_000;
/** A little past the reset, so the first check does not race it. */
const AFTER_RESET_MS = 30_000;

let active = false;
let resumesAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let probe: (() => Promise<boolean>) | null = null;
const listeners = new Set<Listener>();

export const isQuotaActive = (): boolean => active;

/** Called on every change of state. Returns the unsubscribe. */
export function onQuotaChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * How to ask the hub whether D1 answers again.
 *
 * Injected rather than imported, because the thing that knows how to reach the
 * hub is `dataHub`, which itself reports into this file — importing it here
 * would be a cycle.
 */
export function setQuotaProbe(fn: () => Promise<boolean>): void {
  probe = fn;
}

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(active); } catch { /* one listener must not stop the rest */ }
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void check(); }, Math.max(1_000, delay));
}

async function check(): Promise<void> {
  timer = null;
  if (!active) return;
  let answered = false;
  try {
    answered = probe ? await probe() : false;
  } catch {
    answered = false;
  }
  if (answered) {
    reportResumed();
    return;
  }
  // Still refused, or the check itself failed. Either way, not yet.
  schedule(RETRY_MS);
}

/** The hub said the quota is spent, and when it resets. */
export function reportQuota(resetAt: number): void {
  const at = Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0;
  const wasActive = active;
  active = true;
  if (at > resumesAt) resumesAt = at;
  // Checking before the reset is pointless — the answer is known.
  schedule((resumesAt || Date.now()) - Date.now() + AFTER_RESET_MS);
  if (!wasActive) emit();
}

/** D1 answers again. */
export function reportResumed(): void {
  if (!active) return;
  active = false;
  resumesAt = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  emit();
}

/**
 * Reads a hub response for the quota signal.
 *
 * Returns true when it WAS the quota, so a caller can skip its own error path.
 * Reads a clone, because the caller usually wants the body too.
 */
export async function noteHubResponse(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = (await res.clone().json()) as { code?: unknown; resumes_at?: unknown };
    if (body.code !== 'd1_quota') return false;
    reportQuota(Number(body.resumes_at));
    return true;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetQuotaForTests(): void {
  active = false;
  resumesAt = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  listeners.clear();
  probe = null;
}
