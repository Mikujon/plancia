import type { StaffingQuery, StaffingReading, WfmPort } from "../../ports/wfm.ts";
import { translateStaffing } from "./traduzione.ts";

export class HttpWfmAdapter implements WfmPort {
  readonly name = "http";
  constructor(private baseUrl: string, private token?: string, private timeoutMs = 5000) {}

  async liveStaffing(q: StaffingQuery): Promise<StaffingReading[]> {
    const url = new URL("/staffing", this.baseUrl);
    url.searchParams.set("date", q.date);
    url.searchParams.set("shift_id", q.shift_id);
    url.searchParams.set("team_ids", q.team_ids.join(","));
    const res = await fetch(url, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // The body may carry agent names: only the status leaves this file.
    if (!res.ok) throw new Error(`WFM responded ${res.status}`);
    return translateStaffing(await res.json());
  }
}
