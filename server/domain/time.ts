import type { Shift } from "./types.ts";

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const iso = (d: Date) => d.toISOString();
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
export const minutesBetween = (a: string | Date, b: string | Date) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Where `now` sits inside a shift. Times are UTC in the demo; a real deployment
 * sets the site time zone. Night shifts wrap past midnight.
 */
export function shiftWindow(s: Shift, now: Date): { active: boolean; hoursLeft: number; date: string } {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = toMin(s.start_hhmm);
  const end = toMin(s.end_hhmm);
  const today = dayOf(now);
  if (end > start) {
    const active = m >= start && m < end;
    return { active, hoursLeft: active ? (end - m) / 60 : 0, date: today };
  }
  // wraps midnight: the part after midnight belongs to yesterday's shift
  if (m >= start) return { active: true, hoursLeft: (24 * 60 - m + end) / 60, date: today };
  if (m < end) return { active: true, hoursLeft: (end - m) / 60, date: dayOf(addDays(now, -1)) };
  return { active: false, hoursLeft: 0, date: today };
}
