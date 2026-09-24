/**
 * ops.v1 — the contract Plancia exposes to Nodo (and anyone else).
 *
 * Self-contained on purpose: this file only imports `zod`, so Nodo can copy it
 * as `src/contracts/ops.v1.ts` unchanged and generate its connector around it
 * (`node scripts/nuovo-connettore.mjs ops "Plancia — Ops"`, then replace the
 * placeholder `Elemento` with these schemas).
 *
 * Rules (from Nodo's connector contract, 9.1–9.4):
 * - the version is in the method name: `ops.v1.list_issues`, never `ops.list_issues`;
 * - a previous version stays alive at least 90 days after the next one ships;
 * - cursors are opaque: pass them back as they are, never decode them;
 * - every response carries `observed_at` — when Plancia read the data;
 * - errors carry a code and an HTTP status, never personal data.
 */
import { z } from "zod";

export const OPS_CONTRACT_VERSION = "ops.v1" as const;

export const OPS_LIMITS = {
  /** Items per page: default and ceiling. */
  defaultPageSize: 50,
  maxPageSize: 200,
  /** Widest date range a single call may ask for, in days. */
  maxRangeDays: 92,
} as const;

export const OPS_METHODS = {
  "ops.v1.list_campaigns": { method: "GET", path: "/api/ops/v1/campaigns" },
  "ops.v1.list_issues": { method: "GET", path: "/api/ops/v1/issues" },
  "ops.v1.get_issue": { method: "GET", path: "/api/ops/v1/issues/:id" },
  "ops.v1.create_issue": { method: "POST", path: "/api/ops/v1/issues" },
  "ops.v1.list_staffing": { method: "GET", path: "/api/ops/v1/staffing" },
  "ops.v1.cost_rollup": { method: "GET", path: "/api/ops/v1/cost-rollup" },
  "ops.v1.list_handovers": { method: "GET", path: "/api/ops/v1/handovers" },
  "ops.v1.kpi_scorecard": { method: "GET", path: "/api/ops/v1/kpis" },
} as const;
export type OpsMethod = keyof typeof OPS_METHODS;

// ── enums ────────────────────────────────────────────────────────────────
export const Layer = z.enum(["TL", "FM", "CSDM", "COO"]);
export const Category = z.enum(["staffing", "system", "quality", "client", "sla", "hr", "other"]);
export const Severity = z.enum(["low", "medium", "high", "critical"]);
export const Status = z.enum(["open", "in_progress", "resolved", "closed"]);
export const ImpactType = z.enum(["none", "overtime", "understaffing", "sla_penalty", "other"]);
export const Source = z.enum(["floor", "google_chat", "telegram", "rta", "kpi", "nodo"]);

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Timestamp = z.iso.datetime();

// ── envelopes ────────────────────────────────────────────────────────────
export const Envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ version: z.literal(OPS_CONTRACT_VERSION), observed_at: Timestamp, data });

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    version: z.literal(OPS_CONTRACT_VERSION),
    observed_at: Timestamp,
    items: z.array(item),
    /** Opaque. Null on the last page. */
    next_cursor: z.string().nullable(),
  });

export const ErrorCode = z.enum(["OPS-400-INPUT", "OPS-401-AUTH", "OPS-404-NOT_FOUND", "OPS-409-CONFLICT", "OPS-500-INTERNAL"]);
export const ErrorBody = z.object({ version: z.literal(OPS_CONTRACT_VERSION), error: z.object({ code: ErrorCode, message: z.string() }) });

// ── domain ───────────────────────────────────────────────────────────────
export const Person = z.object({ id: z.string(), name: z.string(), role: Layer });

export const Campaign = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  sla_target_pct: z.number(),
  teams: z.array(z.object({ id: z.string(), name: z.string(), floor_id: z.string() })),
});

export const Impact = z.object({
  type: ImpactType,
  hours: z.number().nonnegative(),
  /** Margin effect in EUR (positive = cost). */
  amount_eur: z.number().nonnegative(),
});

export const Issue = z.object({
  id: z.string(), ref: z.string(),
  campaign_id: z.string(), client_id: z.string(), team_id: z.string(),
  title: z.string(), category: Category, severity: Severity, status: Status,
  layer: Layer, owner: Person, sla_related: z.boolean(),
  source: Source, impact: Impact,
  created_at: Timestamp, updated_at: Timestamp, resolved_at: Timestamp.nullable(),
  /** Resolution due date. Missing it moves the action to the owner's manager. */
  due_at: Timestamp,
  due_state: z.enum(["done", "done_late", "overdue", "due_soon", "on_track"]),
  /** KPI this action addresses, if any. */
  kpi: z.string().nullable(),
  /** Minutes before automatic escalation to the owner's manager; null when none applies. */
  escalates_in_min: z.number().nullable(),
});

export const ChainStep = z.object({
  layer: Layer, owner: Person.pick({ id: true, name: true }),
  entered_at: Timestamp, left_at: Timestamp.nullable(), minutes: z.number(),
  how: z.enum(["raised", "manual", "auto"]),
});

export const IssueEvent = z.object({
  at: Timestamp,
  type: z.enum(["created", "assigned", "status", "escalated", "comment", "cost", "due", "resolved", "reopened"]),
  actor: z.string().nullable(),
  from: z.string().nullable(), to: z.string().nullable(), note: z.string().nullable(),
});

export const IssueDetail = Issue.extend({
  description: z.string(), resolution: z.string().nullable(),
  chain: z.array(ChainStep), events: z.array(IssueEvent),
});

export const StaffingLine = z.object({
  campaign_id: z.string(), team_id: z.string(), date: Day, shift_id: z.string(), shift_name: z.string(),
  required: z.number().int(), scheduled: z.number().int(), present: z.number().int(),
  gap: z.number().int(), gap_pct: z.number(), hours_left: z.number(),
  /** Revenue at risk if the gap holds to the end of the shift, EUR. */
  gap_cost_eur: z.number(),
  at_risk: z.boolean(), source: z.enum(["rta", "manual"]),
  /** When the feed read this line (can be older than the envelope's observed_at). */
  read_at: Timestamp,
});

export const CostRollupLine = z.object({
  campaign_id: z.string(), client_id: z.string(),
  revenue_eur: z.number(), labour_cost_eur: z.number(), sla_penalty_eur: z.number(),
  margin_eur: z.number(), margin_pct: z.number(),
  issue_cost_eur: z.number(), issues: z.number().int(), sla_days_missed: z.number().int(), days: z.number().int(),
  open_issues: z.number().int(), open_risk_eur: z.number(),
});
export const CostRollup = z.object({
  from: Day, to: Day, updated_through: Day.nullable(), lines: z.array(CostRollupLine),
});

export const Handover = z.object({
  id: z.string(), team_id: z.string(), campaign_id: z.string(), date: Day, shift_id: z.string(),
  author: Person.pick({ id: true, name: true }), notes: z.string(), headcount_note: z.string().nullable(),
  acknowledged_at: Timestamp.nullable(), created_at: Timestamp,
  issue_refs: z.array(z.string()),
});

// ── parameters ───────────────────────────────────────────────────────────
const PageSize = z.coerce.number().int().min(1).max(OPS_LIMITS.maxPageSize).default(OPS_LIMITS.defaultPageSize);

export const ListIssuesParams = z.object({
  campaign_id: z.string().optional(),
  client_id: z.string().optional(),
  status: z.enum(["open", "resolved", "all"]).default("all"),
  layer: Layer.optional(),
  /** Only issues changed at or after this instant — for incremental sync. */
  updated_since: Timestamp.optional(),
  cursor: z.string().optional(),
  limit: PageSize,
});

export const CreateIssueParams = z.object({
  team_id: z.string(),
  title: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  category: Category,
  severity: Severity,
  sla_related: z.boolean().optional(),
  impact_type: ImpactType.optional(),
  impact_hours: z.number().nonnegative().max(10_000).optional(),
  impact_amount: z.number().nonnegative().max(10_000_000).optional(),
  /** Id of the record in the caller's system, for traceability. */
  external_ref: z.string().max(200).optional(),
  due_at: Timestamp.optional(),
});

export const KpiValue = z.object({
  value: z.number().nullable(), target: z.number(), amber: z.number(),
  rag: z.enum(["green", "amber", "red", "none"]), prev: z.number().nullable(), delta: z.number().nullable(),
});
/** One row per node of the hierarchy (COO, CSDM account, Floor Manager, Team Leader), parent first. */
export const ScorecardNode = z.object({
  id: z.string(), parent_id: z.string().nullable(), level: z.enum(["COO", "CSDM", "FM", "TL", "TEAM"]),
  name: z.string(), label: z.string(), team_ids: z.array(z.string()), volume: z.number(),
  kpis: z.record(z.string(), KpiValue),
});
export const KpiScorecardParams = z.object({ from: Day, to: Day }).superRefine((v, ctx) => {
  const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
  if (!(days > 0 && days <= OPS_LIMITS.maxRangeDays)) ctx.addIssue({ code: "custom", message: `from < to, at most ${OPS_LIMITS.maxRangeDays} days apart` });
});

export const StaffingParams = z.object({ campaign_id: z.string().optional() });

const Range = z.object({ from: Day, to: Day }).refine(
  (r) => r.from <= r.to && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= OPS_LIMITS.maxRangeDays,
  { message: `from ≤ to, at most ${OPS_LIMITS.maxRangeDays} days apart` },
);
export const CostRollupParams = z.object({ from: Day, to: Day, client_id: z.string().optional() })
  .superRefine((v, ctx) => {
    const r = Range.safeParse(v);
    if (!r.success) ctx.addIssue({ code: "custom", message: r.error.issues[0].message });
  });

export const ListHandoversParams = z.object({
  team_id: z.string().optional(),
  from: Day.optional(),
  cursor: z.string().optional(),
  limit: PageSize,
});

export type TIssue = z.infer<typeof Issue>;
export type TIssueDetail = z.infer<typeof IssueDetail>;
export type TStaffingLine = z.infer<typeof StaffingLine>;
export type TCostRollup = z.infer<typeof CostRollup>;
export type THandover = z.infer<typeof Handover>;
export type TCampaign = z.infer<typeof Campaign>;
