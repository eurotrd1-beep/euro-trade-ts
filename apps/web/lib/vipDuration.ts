/**
 * VIP duration units — `_calculateVipDuration` / `_unitLabel`
 * (admin_dashboard.dart:1609, :1624).
 *
 * Exactly ONE unit is selected at a time; the value is a plain count of that
 * unit. A month is 30 days and a year is 365 days, matching the Dart
 * `Duration(days: value * 30)` arithmetic.
 */

export type VipUnit = 'minutes' | 'hours' | 'days' | 'months' | 'years';

export const VIP_UNITS: Array<{ unit: VipUnit; chip: string }> = [
  { unit: 'years', chip: '🗓 سنين' },
  { unit: 'months', chip: '📅 شهور' },
  { unit: 'days', chip: '📆 أيام' },
  { unit: 'hours', chip: '🕐 ساعات' },
  { unit: 'minutes', chip: '⏱ دقائق' },
];

/** `_unitLabel`. */
export function unitLabel(unit: VipUnit): string {
  switch (unit) {
    case 'years':
      return 'سنين';
    case 'months':
      return 'شهور';
    case 'days':
      return 'أيام';
    case 'hours':
      return 'ساعات';
    case 'minutes':
      return 'دقائق';
    default:
      return unit;
  }
}

const MINUTE = 60_000;

/** `_calculateVipDuration`, in milliseconds. */
export function vipDurationMs(unit: VipUnit, value: number): number {
  switch (unit) {
    case 'years':
      return value * 365 * 24 * 60 * MINUTE;
    case 'months':
      return value * 30 * 24 * 60 * MINUTE;
    case 'days':
      return value * 24 * 60 * MINUTE;
    case 'hours':
      return value * 60 * MINUTE;
    case 'minutes':
      return value * MINUTE;
    default:
      return value * 24 * 60 * MINUTE;
  }
}

/** The `'$val ${_unitLabel(unit)}'` string stored as `durationText`. */
export function durationText(unit: VipUnit, value: number): string {
  return `${value} ${unitLabel(unit)}`;
}

/** Quick shortcuts, same set as the Dart dialog plus a year. */
export const VIP_PRESETS: Array<{ unit: VipUnit; value: number; label: string }> = [
  { unit: 'days', value: 1, label: '1 يوم' },
  { unit: 'days', value: 7, label: '7 أيام' },
  { unit: 'months', value: 1, label: '1 شهر' },
  { unit: 'months', value: 3, label: '3 شهور' },
  { unit: 'months', value: 6, label: '6 شهور' },
  { unit: 'months', value: 12, label: '12 شهر' },
  { unit: 'years', value: 1, label: 'سنة' },
];

/** `DateFormat('yyyy/MM/dd HH:mm')`. */
export function formatExpiry(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
