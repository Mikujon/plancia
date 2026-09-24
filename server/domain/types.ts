export const ROLES = ["TL", "FM", "CSDM", "COO"] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = ["staffing", "system", "quality", "client", "sla", "hr", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];

export const IMPACT_TYPES = ["none", "overtime", "understaffing", "sla_penalty", "other"] as const;
export type ImpactType = (typeof IMPACT_TYPES)[number];

export const SOURCES = ["floor", "google_chat", "telegram", "rta", "kpi", "nodo"] as const;
export type Source = (typeof SOURCES)[number];

export interface User { id: string; name: string; role: Role; email: string | null; manager_id: string | null }
export interface Client { id: string; name: string; color: string }
export interface Campaign {
  id: string; client_id: string; name: string; code: string;
  hourly_cost: number; billing_rate: number; overtime_multiplier: number;
  sla_target_pct: number; sl_threshold_sec: number; sla_penalty_per_day: number; csdm_id: string;
}
export interface Floor { id: string; name: string; site: string }
export interface Team { id: string; name: string; floor_id: string; campaign_id: string; tl_id: string }
export interface Shift { id: string; name: string; start_hhmm: string; end_hhmm: string }

export interface Issue {
  id: string; ref: string; campaign_id: string; team_id: string;
  title: string; description: string; category: Category; severity: Severity;
  status: Status; layer: Role; layer_since: string; owner_id: string;
  raised_by: string | null; source: Source; source_ref: string | null;
  sla_related: number; impact_type: ImpactType; impact_hours: number; impact_amount: number;
  resolution: string | null; kpi: string | null; due_at: string; acknowledged_at: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
}

export interface IssueEvent {
  id: number; issue_id: string; at: string; actor_id: string | null;
  type: "created" | "assigned" | "status" | "escalated" | "comment" | "cost" | "due" | "resolved" | "reopened";
  from_value: string | null; to_value: string | null; note: string | null;
}

export class DomainError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) {
    super(message);
  }
}

export const isOpen = (s: Status) => s === "open" || s === "in_progress";
