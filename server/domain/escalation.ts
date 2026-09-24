import { isOpen, type Issue, type Severity } from "./types.ts";
import { minutesBetween } from "./time.ts";

/**
 * Two clocks run on every open action:
 * 1. Pick-up: the owner must take it (status → in progress) within `ackMinutes`.
 * 2. Due date: it must be resolved by `due_at` (set from `resolveHours` at creation, editable with a reason).
 * Missing either moves it to the owner's manager — one level, never skipping — with a fresh,
 * shorter window, so the chain of who owned it and why it moved is always explicit.
 */
export interface DuePolicy {
  ackMinutes: Record<Severity, number>;
  resolveHours: Record<Severity, number>;
  /** After an escalation the new owner gets this share of the original window… */
  escalatedShare: number;
  /** …but never less than this. */
  minWindowHours: number;
  /** "Due soon" horizon for dashboards. */
  dueSoonHours: number;
}

export const DEFAULT_POLICY: DuePolicy = {
  ackMinutes: { critical: 15, high: 30, medium: 120, low: 480 },
  resolveHours: { critical: 4, high: 24, medium: 72, low: 168 },
  escalatedShare: 0.5,
  minWindowHours: 1,
  dueSoonHours: 24,
};

const H = 3_600_000;

export function initialDue(created: Date, severity: Severity, p: DuePolicy = DEFAULT_POLICY): string {
  return new Date(created.getTime() + p.resolveHours[severity] * H).toISOString();
}

/** Due date for the next owner after an escalation: never earlier than the current one. */
export function escalatedDue(i: Pick<Issue, "due_at" | "severity">, now: Date, p: DuePolicy = DEFAULT_POLICY): string {
  const fresh = now.getTime() + Math.max(p.minWindowHours, p.resolveHours[i.severity] * p.escalatedShare) * H;
  return new Date(Math.max(fresh, Date.parse(i.due_at))).toISOString();
}

export type EscalationReason = "not_picked_up" | "overdue";

/** Why this action should move up now, if it should. The caller checks there is a manager to move it to. */
export function autoEscalation(
  i: Pick<Issue, "status" | "severity" | "layer_since" | "acknowledged_at" | "due_at">,
  now: Date,
  p: DuePolicy = DEFAULT_POLICY,
): EscalationReason | null {
  if (!isOpen(i.status)) return null;
  if (!i.acknowledged_at && minutesBetween(i.layer_since, now) >= p.ackMinutes[i.severity]) return "not_picked_up";
  if (now.getTime() >= Date.parse(i.due_at)) return "overdue";
  return null;
}

/** Minutes until the next automatic escalation (pick-up or due date, whichever comes first). */
export function minutesToEscalation(
  i: Pick<Issue, "status" | "severity" | "layer_since" | "acknowledged_at" | "due_at">,
  now: Date,
  p: DuePolicy = DEFAULT_POLICY,
): number | null {
  if (!isOpen(i.status)) return null;
  const toDue = minutesBetween(now, i.due_at);
  const toPickup = i.acknowledged_at ? Infinity : p.ackMinutes[i.severity] - minutesBetween(i.layer_since, now);
  return Math.round(Math.min(toDue, toPickup));
}

export type DueState = "done" | "done_late" | "overdue" | "due_soon" | "on_track";

export function dueState(i: Pick<Issue, "status" | "due_at" | "resolved_at">, now: Date, p: DuePolicy = DEFAULT_POLICY): DueState {
  if (!isOpen(i.status)) return i.resolved_at && i.resolved_at > i.due_at ? "done_late" : "done";
  const left = Date.parse(i.due_at) - now.getTime();
  if (left <= 0) return "overdue";
  return left <= p.dueSoonHours * H ? "due_soon" : "on_track";
}
