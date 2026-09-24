import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type Role = "TL" | "FM" | "CSDM" | "COO";
export interface User { id: string; name: string; role: Role; email: string | null; manager_id: string | null }
export interface Client { id: string; name: string; color: string }
export interface Campaign { id: string; client_id: string; name: string; code: string; hourly_cost: number; billing_rate: number; sla_target_pct: number; csdm_id: string }
export interface Floor { id: string; name: string; site: string }
export interface Team { id: string; name: string; floor_id: string; campaign_id: string; tl_id: string }
export interface Shift { id: string; name: string; start_hhmm: string; end_hhmm: string }
export interface Org { users: User[]; clients: Client[]; campaigns: Campaign[]; floors: Floor[]; teams: Team[]; shifts: Shift[]; wfm: string; today: string }

export interface IssueRow {
  id: string; ref: string; campaign_id: string; team_id: string; title: string; description: string;
  category: string; severity: "low" | "medium" | "high" | "critical"; status: "open" | "in_progress" | "resolved" | "closed";
  layer: Role; layer_since: string; owner_id: string; owner_name: string; owner_role: Role; team_name: string; floor_id: string;
  campaign_name: string; campaign_code: string; client_id: string; client_name: string; source: string; source_ref: string | null;
  sla_related: number; impact_type: string; impact_hours: number; impact_amount: number; resolution: string | null;
  created_at: string; updated_at: string; resolved_at: string | null; escalates_in_min: number | null;
  kpi: string | null; due_at: string; acknowledged_at: string | null; due_in_min: number;
  due_state: "done" | "done_late" | "overdue" | "due_soon" | "on_track";
}
export interface EventRow { id: number; at: string; actor_id: string | null; actor_name: string | null; type: string; from_value: string | null; to_value: string | null; note: string | null }
export interface ChainStep { layer: Role; owner_id: string; owner_name: string; entered_at: string; left_at: string | null; how: "raised" | "manual" | "auto"; minutes?: number }

// ── who is signed in (demo: chosen from a list; SSO later) ──
const KEY = "plancia.user";
let currentUser: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
const userListeners = new Set<() => void>();
export function setUser(id: string | null) {
  currentUser = id;
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  userListeners.forEach((l) => l());
}
export const useUserId = () => useSyncExternalStore((l) => { userListeners.add(l); return () => userListeners.delete(l); }, () => currentUser);

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: { ...(currentUser ? { "x-user-id": currentUser } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

// ── live changes: one SSE connection; every query refetches when something changes ──
let version = 0;
const versionListeners = new Set<() => void>();
let es: EventSource | null = null;
let live = false;
const liveListeners = new Set<() => void>();
function connect() {
  if (es) return;
  es = new EventSource("/api/stream");
  let timer: ReturnType<typeof setTimeout> | null = null;
  es.addEventListener("change", () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; version++; versionListeners.forEach((l) => l()); }, 250);
  });
  es.onopen = () => { live = true; liveListeners.forEach((l) => l()); };
  es.onerror = () => { live = false; liveListeners.forEach((l) => l()); };
}
export const useLive = () => useSyncExternalStore((l) => { connect(); liveListeners.add(l); return () => liveListeners.delete(l); }, () => live);
const useVersion = () => useSyncExternalStore((l) => { connect(); versionListeners.add(l); return () => versionListeners.delete(l); }, () => version);

/** Fetches `path` and refetches on any live change (and every `pollMs` for time-based data). */
export function useApi<T>(path: string | null, pollMs?: number) {
  const v = useVersion();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const lastPath = useRef(path);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    if (lastPath.current !== path) { lastPath.current = path; setState((s) => ({ ...s, loading: true })); }
    api<T>(path).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: Error) => alive && setState((s) => ({ data: s.data, error: e.message, loading: false })),
    );
    return () => { alive = false; };
  }, [path, v, tick]);
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => setTick((x) => x + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { ...state, reload };
}

// ── formatting ──
export const eur = (n: number, digits = 0) =>
  `€${n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const eurShort = (n: number) => (Math.abs(n) >= 10_000 ? `€${(n / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}k` : eur(n));
export function ago(isoStr: string) {
  const m = Math.round((Date.now() - Date.parse(isoStr)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min ` : ""}ago`;
  return `${Math.floor(m / 1440)} d ago`;
}
export const dur = (m: number | null | undefined) =>
  m == null ? "—" : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${(m / 1440).toFixed(1)} d`;
export const when = (isoStr: string) =>
  new Date(isoStr).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
export const ROLE_NAME: Record<Role, string> = { TL: "Team Leader", FM: "Floor Manager", CSDM: "CSDM", COO: "COO" };
export const CATEGORIES = ["staffing", "system", "quality", "client", "sla", "hr", "other"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const IMPACTS = ["none", "overtime", "understaffing", "sla_penalty", "other"] as const;
export const IMPACT_NAME: Record<string, string> = { none: "No cost", overtime: "Overtime", understaffing: "Understaffing", sla_penalty: "SLA penalty risk", other: "Other cost" };

// ── KPIs ──
export type Rag = "green" | "amber" | "red" | "none";
export interface KpiValue { value: number | null; target: number; amber: number; rag: Rag; prev: number | null; delta: number | null }
export interface KpiDef { code: string; name: string; unit: "%" | "s" | "€"; better: "higher" | "lower" | "band"; group: string; finance: boolean; formula: string; target: number; amber: number }
export interface ScoreNode { id: string; level: Role | "TEAM"; name: string; label: string; owner_id: string | null; team_ids: string[]; volume: number; kpis: Record<string, KpiValue>; children: ScoreNode[] }
export interface Driver { code: string; label: string; value: number; unit: string; adverse: boolean; text: string }
export interface Exception {
  node_id: string; node_name: string; label: string; level: string; team_ids: string[]; kpi: string; kpi_name: string; unit: string;
  value: number; target: number; severity: number; drivers: Driver[]; spark: (number | null)[];
  open_action: { id: string; ref: string; due_at: string; owner_name: string } | null;
}
export interface DueSummary {
  open: number; overdue: number; due_today: number; due_week: number; not_picked_up: number; closed_30d: number;
  on_time_pct: number | null; avg_days_late: number | null;
  by_manager: { user_id: string; name: string; role: Role; open: number; overdue: number; on_time_pct: number | null }[];
}

export function fmtKpi(unit: string, v: number | null | undefined, digits?: number) {
  if (v == null) return "—";
  if (unit === "s") return `${Math.round(v)}s`;
  if (unit === "€") return `€${v.toFixed(digits ?? 2)}`;
  return `${v.toFixed(digits ?? 1)}%`;
}
export function fmtDelta(unit: string, d: number | null | undefined) {
  if (d == null) return "";
  const s = d > 0 ? "+" : d < 0 ? "−" : "±";
  const a = Math.abs(d);
  return unit === "s" ? `${s}${Math.round(a)}s` : unit === "€" ? `${s}€${a.toFixed(2)}` : `${s}${a.toFixed(1)} pt`;
}
/** Whether a change is good news for this KPI. */
export function deltaGood(def: Pick<KpiDef, "better">, k: KpiValue) {
  if (k.delta == null || k.delta === 0) return null;
  if (def.better === "higher") return k.delta > 0;
  if (def.better === "lower") return k.delta < 0;
  return k.prev != null && k.value != null ? Math.abs(k.value - k.target) < Math.abs(k.prev - k.target) : null;
}
export function dueText(i: Pick<IssueRow, "due_at" | "due_in_min" | "due_state">) {
  if (i.due_state === "done" || i.due_state === "done_late") return i.due_state === "done_late" ? "closed late" : "closed on time";
  const m = i.due_in_min;
  const abs = Math.abs(m);
  const span = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return m < 0 ? `overdue by ${span}` : `due in ${span}`;
}
export const PERIODS: [string, string][] = [["1", "Yesterday"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];
