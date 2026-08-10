/**
 * Community figures shown on the login screen.
 *
 * These are PRESENTATION numbers, not measurements — nothing here reads the
 * database. They are computed from the calendar date so the page shows a
 * steadily growing figure instead of a number frozen at build time, and so
 * every visitor on a given day sees the same value.
 *
 * The floor is the "+1500 members" the owner asked for; the count only ever
 * goes up from there.
 */

/** Anchor date. Growth is counted in whole days from here, in UTC. */
const EPOCH_UTC = Date.UTC(2026, 0, 1);

const MEMBERS_FLOOR = 1500;
const MEMBERS_PER_DAY = 6;

const PROFIT_FLOOR = 4_820_000;
const PROFIT_PER_DAY = 27_400;

export interface CommunityStats {
  members: number;
  profitUsd: number;
}

/** What the server renders, before the client knows today's date. */
export const BASE_STATS: CommunityStats = {
  members: MEMBERS_FLOOR,
  profitUsd: PROFIT_FLOOR,
};

/** Whole days elapsed since the anchor, never negative. */
function daysElapsed(now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - EPOCH_UTC) / 86_400_000));
}

export function communityStats(now: Date = new Date()): CommunityStats {
  const days = daysElapsed(now);
  return {
    members: MEMBERS_FLOOR + days * MEMBERS_PER_DAY,
    profitUsd: PROFIT_FLOOR + days * PROFIT_PER_DAY,
  };
}

/** `4,820,000` → `$4.8M`, so a seven-figure number still fits the stat box. */
export function compactUsd(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `$${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${value}`;
}

/** `1506` → `+1,506`. */
export function compactMembers(value: number): string {
  return `+${value.toLocaleString('en-US')}`;
}
