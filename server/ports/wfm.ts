import { z } from "zod";

/** One reading from the WFM/RTA feed: plan vs. who is actually logged in. */
export const StaffingReading = z.object({
  team_id: z.string(),
  shift_id: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  required: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
  present: z.number().int().nonnegative(),
  /** When the source read the value — not when it answered. */
  observed_at: z.iso.datetime(),
});
export type StaffingReading = z.infer<typeof StaffingReading>;

export interface StaffingQuery { date: string; shift_id: string; team_ids: string[] }

/** What Plancia needs from a workforce-management / real-time-adherence system. */
export interface WfmPort {
  readonly name: string;
  liveStaffing(q: StaffingQuery): Promise<StaffingReading[]>;
}
