import type { StaffingQuery, StaffingReading, WfmPort } from "../../ports/wfm.ts";
import { systemClock, type Clock } from "../../domain/time.ts";

/** FNV-1a: same input, same number — keeps the fake feed deterministic. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic stand-in for the RTA feed. Same team, shift and 10-minute
 * window → same numbers, so tests repeat; the window moving makes the demo feel live.
 */
export class MockWfmAdapter implements WfmPort {
  readonly name = "mock";
  constructor(
    private required: (teamId: string, shiftId: string) => number,
    private opts: { now?: Clock } = {},
  ) {}

  async liveStaffing(q: StaffingQuery): Promise<StaffingReading[]> {
    const now = (this.opts.now ?? systemClock)();
    const bucket = Math.floor(now.getTime() / 600_000);
    const observed_at = new Date(bucket * 600_000).toISOString();
    return q.team_ids.map((team_id) => {
      const required = this.required(team_id, q.shift_id);
      const h = hash(`${team_id}|${q.shift_id}|${q.date}|${bucket}`);
      const dayH = hash(`${team_id}|${q.date}`);
      const scheduled = Math.max(0, required - (dayH % 3 === 0 ? 1 : 0) - (dayH % 7 === 0 ? 2 : 0));
      // one team in five runs a heavy absence day
      const absent = (h % 3) + (dayH % 5 === 0 ? 3 + (h % 3) : 0);
      const present = Math.max(0, scheduled - absent);
      return { team_id, shift_id: q.shift_id, date: q.date, required, scheduled, present, observed_at };
    });
  }
}
