import { z } from "zod";
import { StaffingReading } from "../../ports/wfm.ts";

/**
 * The only file that changes when the real WFM/RTA answers in a different shape.
 * Until its API is known, it expects the port's own shape: `{ items: StaffingReading[] }`.
 */
const Response = z.object({ items: z.array(StaffingReading) });

export function translateStaffing(body: unknown): StaffingReading[] {
  return Response.parse(body).items;
}
