import { randomUUID } from "node:crypto";
import { all, get, run, tx, type DB } from "../db.ts";
import type { Bus } from "../bus.ts";
import { impactAmount } from "./cost.ts";
import {
  autoEscalation, DEFAULT_POLICY, dueState, escalatedDue, initialDue, minutesToEscalation,
  type DuePolicy, type DueState,
} from "./escalation.ts";
import { assertTeamVisible, campaignById, chainAbove, isAtOrAbove, ownerFor, teamById, userById, visibleTeamIds } from "./org.ts";
import { iso, minutesBetween, type Clock } from "./time.ts";
import {
  DomainError, isOpen,
  type Category, type ImpactType, type Issue, type IssueEvent, type Role, type Severity, type Source, type Status, type User,
} from "./types.ts";

export interface Deps { db: DB; bus: Bus; clock: Clock; policy?: DuePolicy }

export interface IssueRow extends Issue {
  owner_name: string; owner_role: Role; team_name: string; floor_id: string;
  campaign_name: string; campaign_code: string; client_id: string; client_name: string;
  /** Minutes before the next automatic escalation (pick-up or due date); null when none applies. */
  escalates_in_min: number | null;
  due_state: DueState;
  /** Minutes to the due date; negative when overdue. */
  due_in_min: number;
}

export interface ChainStep { layer: Role; owner_id: string; owner_name: string; entered_at: string; left_at: string | null; how: "raised" | "manual" | "auto" }

const SELECT_ROW = `
  SELECT i.*, u.name AS owner_name, u.role AS owner_role, t.name AS team_name, t.floor_id,
         c.name AS campaign_name, c.code AS campaign_code, c.client_id, cl.name AS client_name
  FROM issues i
  JOIN users u ON u.id = i.owner_id
  JOIN teams t ON t.id = i.team_id
  JOIN campaigns c ON c.id = i.campaign_id
  JOIN clients cl ON cl.id = c.client_id`;

type BaseRow = Omit<IssueRow, "escalates_in_min" | "due_state" | "due_in_min">;

function enrich(d: Deps, r: BaseRow): IssueRow {
  const now = d.clock();
  const p = d.policy ?? DEFAULT_POLICY;
  return {
    ...r,
    // the COO has no one above: the clocks still show as overdue, but nothing moves
    escalates_in_min: r.owner_role === "COO" ? null : minutesToEscalation(r, now, p),
    due_state: dueState(r, now, p),
    due_in_min: Math.round(minutesBetween(now, r.due_at)),
  };
}

function logEvent(db: DB, issueId: string, at: string, actorId: string | null, type: IssueEvent["type"],
  from: string | null, to: string | null, note: string | null = null) {
  run(db, "INSERT INTO issue_events (issue_id, at, actor_id, type, from_value, to_value, note) VALUES (?,?,?,?,?,?,?)",
    issueId, at, actorId, type, from, to, note);
}

function load(db: DB, id: string): Issue {
  const i = get<Issue>(db, "SELECT * FROM issues WHERE id = ? OR ref = ?", id, id);
  if (!i) throw new DomainError(404, "NOT_FOUND", "Issue not found");
  return i;
}

/** The owner, or anyone above the owner in the reporting line, can act. */
function assertCanAct(db: DB, actor: User, i: Issue) {
  assertTeamVisible(db, actor, i.team_id);
  if (!isAtOrAbove(db, actor.id, i.owner_id))
    throw new DomainError(403, "FORBIDDEN", `This sits with the ${i.layer} layer now — you can follow and comment`);
}

export interface CreateIssueInput {
  team_id: string; title: string; description?: string; category: Category; severity: Severity;
  sla_related?: boolean; impact_type?: ImpactType; impact_hours?: number; impact_amount?: number | null;
  source?: Source; source_ref?: string | null; layer?: Role; kpi?: string | null; due_at?: string | null;
}

export function createIssue(d: Deps, actor: User | null, input: CreateIssueInput): Issue {
  const { db } = d;
  const team = teamById(db, input.team_id);
  const campaign = campaignById(db, team.campaign_id);
  if (actor) assertTeamVisible(db, actor, team.id);
  // Raised on the floor it starts with the team's TL; raised by a manager it starts at their own layer.
  const layer: Role = input.layer ?? (actor ? actor.role : "TL");
  const owner = layer === actor?.role ? actor.id : ownerFor(db, layer, team.id);
  const nowD = d.clock();
  const now = iso(nowD);
  const due = input.due_at ?? initialDue(nowD, input.severity, d.policy);
  if (Date.parse(due) <= nowD.getTime()) throw new DomainError(400, "INPUT", "due_at must be in the future");
  const type = input.impact_type ?? "none";
  const hours = input.impact_hours ?? 0;
  const amount = impactAmount(campaign, type, hours, input.impact_amount);
  const id = randomUUID();

  tx(db, () => {
    const n = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues WHERE campaign_id = ?", campaign.id)!.n;
    const ref = `${campaign.code}-${String(n + 1).padStart(4, "0")}`;
    run(db, `INSERT INTO issues (id, ref, campaign_id, team_id, title, description, category, severity, status, layer,
        layer_since, owner_id, raised_by, source, source_ref, sla_related, impact_type, impact_hours, impact_amount,
        kpi, due_at, acknowledged_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ref, campaign.id, team.id, input.title.trim(), input.description?.trim() ?? "", input.category, input.severity,
      layer, now, owner, actor?.id ?? null, input.source ?? "floor", input.source_ref ?? null,
      input.sla_related || input.category === "sla" ? 1 : 0, type, hours, amount, input.kpi ?? null, due,
      // an action a manager raises for themselves is already picked up
      actor && owner === actor.id ? now : null, now, now);
    logEvent(db, id, now, actor?.id ?? null, "created", null, layer, input.source ?? "floor");
    logEvent(db, id, now, actor?.id ?? null, "assigned", null, owner);
    logEvent(db, id, now, actor?.id ?? null, "due", null, due, "initial due date");
    if (amount > 0) logEvent(db, id, now, actor?.id ?? null, "cost", null, String(amount), `${type} · ${hours}h`);
  });
  d.bus.emit({ entity: "issue", id });
  return load(db, id);
}

export interface UpdateIssueInput {
  title?: string; description?: string; category?: Category; severity?: Severity; sla_related?: boolean;
  status?: Status; owner_id?: string; kpi?: string | null;
  impact_type?: ImpactType; impact_hours?: number; impact_amount?: number | null;
  due_at?: string; due_reason?: string;
}

export function updateIssue(d: Deps, actor: User, id: string, p: UpdateIssueInput): Issue {
  const { db } = d;
  const i = load(db, id);
  assertCanAct(db, actor, i);
  const now = iso(d.clock());

  tx(db, () => {
    const set: Record<string, string | number | null> = {};
    for (const k of ["title", "description", "category", "severity", "kpi"] as const)
      if (p[k] !== undefined && p[k] !== i[k]) set[k] = p[k]!;
    if (p.sla_related !== undefined && Number(p.sla_related) !== i.sla_related) set.sla_related = p.sla_related ? 1 : 0;

    if (p.status && p.status !== i.status) {
      if (p.status === "resolved") throw new DomainError(400, "USE_RESOLVE", "Resolve with a resolution note");
      if (p.status === "closed" && i.status !== "resolved") throw new DomainError(409, "NOT_RESOLVED", "Only resolved issues can be closed");
      set.status = p.status;
      // taking it stops the pick-up clock
      if (p.status === "in_progress" && !i.acknowledged_at) set.acknowledged_at = now;
      logEvent(db, i.id, now, actor.id, "status", i.status, p.status);
    }
    if (p.owner_id && p.owner_id !== i.owner_id) {
      const o = userById(db, p.owner_id);
      if (o.role !== i.layer) throw new DomainError(400, "WRONG_LAYER", `Owner must be a ${i.layer}`);
      assertTeamVisible(db, o, i.team_id);
      set.owner_id = o.id;
      set.acknowledged_at = null;
      set.layer_since = now;
      logEvent(db, i.id, now, actor.id, "assigned", i.owner_id, o.id);
    }
    if (p.due_at && p.due_at !== i.due_at) {
      if (!isOpen(i.status)) throw new DomainError(409, "NOT_OPEN", "Closed actions keep their due date");
      if (Date.parse(p.due_at) <= Date.parse(now)) throw new DomainError(400, "INPUT", "due_at must be in the future");
      // moving a due date out is a decision someone must own
      if (p.due_at > i.due_at && !p.due_reason?.trim()) throw new DomainError(400, "INPUT", "Say why the due date moves out");
      set.due_at = p.due_at;
      logEvent(db, i.id, now, actor.id, "due", i.due_at, p.due_at, p.due_reason?.trim() || null);
    }
    if (p.impact_type !== undefined || p.impact_hours !== undefined || p.impact_amount !== undefined) {
      const c = campaignById(db, i.campaign_id);
      const type = p.impact_type ?? i.impact_type;
      const hours = p.impact_hours ?? i.impact_hours;
      const amount = impactAmount(c, type, hours, p.impact_amount === undefined ? (type === i.impact_type ? i.impact_amount : null) : p.impact_amount);
      if (type !== i.impact_type || hours !== i.impact_hours || amount !== i.impact_amount) {
        Object.assign(set, { impact_type: type, impact_hours: hours, impact_amount: amount });
        logEvent(db, i.id, now, actor.id, "cost", String(i.impact_amount), String(amount), `${type} · ${hours}h`);
      }
    }
    if (Object.keys(set).length === 0) return;
    set.updated_at = now;
    const cols = Object.keys(set);
    run(db, `UPDATE issues SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]), i.id);
  });
  d.bus.emit({ entity: "issue", id: i.id });
  return load(db, i.id);
}

/** Moves an action to the owner's manager — exactly one level up. */
export function escalateIssue(d: Deps, actor: User | null, id: string, reason: string): Issue {
  const { db } = d;
  const i = load(db, id);
  if (actor) assertCanAct(db, actor, i);
  if (!isOpen(i.status)) throw new DomainError(409, "NOT_OPEN", "Only open issues can be escalated");
  const manager = chainAbove(db, i.owner_id)[0];
  if (!manager) throw new DomainError(409, "TOP_LAYER", "Already at the top of the reporting line");
  const nowD = d.clock();
  const now = iso(nowD);
  const due = escalatedDue(i, nowD, d.policy);
  tx(db, () => {
    run(db, `UPDATE issues SET layer = ?, layer_since = ?, owner_id = ?, status = 'open', acknowledged_at = NULL,
      due_at = ?, updated_at = ? WHERE id = ?`, manager.role, now, manager.id, due, now, i.id);
    logEvent(db, i.id, now, actor?.id ?? null, "escalated", i.layer, manager.role, reason);
    logEvent(db, i.id, now, actor?.id ?? null, "assigned", i.owner_id, manager.id);
    if (due !== i.due_at) logEvent(db, i.id, now, actor?.id ?? null, "due", i.due_at, due, `new window at ${manager.role}`);
  });
  d.bus.emit({ entity: "issue", id: i.id });
  return load(db, i.id);
}

export interface ResolveInput { resolution: string; impact_type?: ImpactType; impact_hours?: number; impact_amount?: number | null }

export function resolveIssue(d: Deps, actor: User, id: string, r: ResolveInput): Issue {
  const { db } = d;
  const i = load(db, id);
  assertCanAct(db, actor, i);
  if (!isOpen(i.status)) throw new DomainError(409, "NOT_OPEN", "Issue is not open");
  if (r.impact_type !== undefined || r.impact_hours !== undefined || r.impact_amount !== undefined)
    updateIssue(d, actor, i.id, { impact_type: r.impact_type, impact_hours: r.impact_hours, impact_amount: r.impact_amount });
  const now = iso(d.clock());
  tx(db, () => {
    run(db, "UPDATE issues SET status = 'resolved', resolution = ?, resolved_at = ?, acknowledged_at = IFNULL(acknowledged_at, ?), updated_at = ? WHERE id = ?",
      r.resolution.trim(), now, now, now, i.id);
    logEvent(db, i.id, now, actor.id, "resolved", i.status, "resolved", r.resolution.trim());
  });
  d.bus.emit({ entity: "issue", id: i.id });
  return load(db, i.id);
}

export function reopenIssue(d: Deps, actor: User, id: string, note: string): Issue {
  const { db } = d;
  const i = load(db, id);
  assertTeamVisible(db, actor, i.team_id);
  if (isOpen(i.status)) throw new DomainError(409, "ALREADY_OPEN", "Issue is already open");
  const nowD = d.clock();
  const now = iso(nowD);
  const due = initialDue(nowD, i.severity, d.policy);
  tx(db, () => {
    run(db, "UPDATE issues SET status = 'open', resolved_at = NULL, acknowledged_at = NULL, layer_since = ?, due_at = ?, updated_at = ? WHERE id = ?",
      now, due, now, i.id);
    logEvent(db, i.id, now, actor.id, "reopened", i.status, "open", note);
    logEvent(db, i.id, now, actor.id, "due", i.due_at, due, "reopened");
  });
  d.bus.emit({ entity: "issue", id: i.id });
  return load(db, i.id);
}

export function commentIssue(d: Deps, actor: User, id: string, text: string) {
  const i = load(d.db, id);
  assertTeamVisible(d.db, actor, i.team_id);
  const now = iso(d.clock());
  logEvent(d.db, i.id, now, actor.id, "comment", null, null, text.trim());
  run(d.db, "UPDATE issues SET updated_at = ? WHERE id = ?", now, i.id);
  d.bus.emit({ entity: "issue", id: i.id });
}

export interface IssueFilter {
  campaign_id?: string; client_id?: string; team_id?: string; status?: "open" | "resolved" | "all";
  layer?: Role; owner_id?: string; category?: Category; kpi?: string; q?: string; from?: string; to?: string;
  due?: "overdue" | "today" | "week"; limit?: number;
}

export function listIssues(d: Deps, u: User | null, f: IssueFilter = {}): IssueRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (u) {
    const ids = [...visibleTeamIds(d.db, u)];
    if (ids.length === 0) return [];
    where.push(`i.team_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (f.campaign_id) { where.push("i.campaign_id = ?"); params.push(f.campaign_id); }
  if (f.client_id) { where.push("c.client_id = ?"); params.push(f.client_id); }
  if (f.team_id) { where.push("i.team_id = ?"); params.push(f.team_id); }
  if (f.status === "open" || f.status === undefined) where.push("i.status IN ('open','in_progress')");
  if (f.status === "resolved") where.push("i.status IN ('resolved','closed')");
  if (f.layer) { where.push("i.layer = ?"); params.push(f.layer); }
  if (f.owner_id) { where.push("i.owner_id = ?"); params.push(f.owner_id); }
  if (f.category) { where.push("i.category = ?"); params.push(f.category); }
  if (f.kpi) { where.push("i.kpi = ?"); params.push(f.kpi); }
  if (f.from) { where.push("i.created_at >= ?"); params.push(f.from); }
  if (f.to) { where.push("i.created_at < ?"); params.push(f.to); }
  if (f.due) {
    const now = d.clock();
    const end = new Date(now);
    if (f.due === "today") end.setUTCHours(23, 59, 59, 999);
    else if (f.due === "week") end.setUTCDate(end.getUTCDate() + 7);
    where.push("i.status IN ('open','in_progress') AND i.due_at <= ?");
    params.push(f.due === "overdue" ? iso(now) : iso(end));
  }
  if (f.q) {
    where.push("(i.title LIKE ? OR i.description LIKE ? OR i.ref LIKE ? OR IFNULL(i.resolution,'') LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like, like);
  }
  const sql = `${SELECT_ROW} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE WHEN i.status IN ('open','in_progress') THEN 0 ELSE 1 END, i.due_at,
      CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT ?`;
  params.push(Math.min(f.limit ?? 300, 2000));
  return all<BaseRow>(d.db, sql, ...params).map((r) => enrich(d, r));
}

export function issueRow(d: Deps, id: string): IssueRow {
  const r = get<BaseRow>(d.db, `${SELECT_ROW} WHERE i.id = ? OR i.ref = ?`, id, id);
  if (!r) throw new DomainError(404, "NOT_FOUND", "Issue not found");
  return enrich(d, r);
}

export type EventRow = IssueEvent & { actor_name: string | null };

export function issueEvents(db: DB, id: string): EventRow[] {
  return all<EventRow>(db,
    `SELECT e.*, u.name AS actor_name FROM issue_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.issue_id = ? ORDER BY e.at, e.id`, id);
}

/** Who owned the issue at each layer, and how it got there. */
export function chainOf(db: DB, i: Issue, events: EventRow[]): ChainStep[] {
  const names = new Map(all<{ id: string; name: string }>(db, "SELECT id, name FROM users").map((u) => [u.id, u.name]));
  const steps: ChainStep[] = [];
  for (const e of events) {
    if (e.type === "created" || e.type === "escalated") {
      const prev = steps.at(-1);
      if (prev) prev.left_at = e.at;
      steps.push({
        layer: e.to_value as Role, owner_id: "", owner_name: "", entered_at: e.at, left_at: null,
        how: e.type === "created" ? "raised" : e.actor_id ? "manual" : "auto",
      });
    } else if (e.type === "assigned" && steps.length) {
      const s = steps.at(-1)!;
      s.owner_id = e.to_value ?? "";
      s.owner_name = names.get(s.owner_id) ?? s.owner_id;
    }
  }
  const last = steps.at(-1);
  if (last && !isOpen(i.status) && i.resolved_at) last.left_at = i.resolved_at;
  return steps;
}

export function getIssue(d: Deps, u: User | null, id: string) {
  const row = issueRow(d, id);
  if (u) assertTeamVisible(d.db, u, row.team_id);
  const events = issueEvents(d.db, row.id);
  return { issue: row, events, chain: chainOf(d.db, row, events) };
}

const REASON_TEXT = {
  not_picked_up: (i: Issue, m: number) => `Auto: not picked up at ${i.layer} within ${m} min (${i.severity})`,
  overdue: (i: Issue) => `Auto: overdue at ${i.layer} (due ${i.due_at.slice(0, 16).replace("T", " ")} UTC)`,
};

/** Moves every action whose pick-up or due-date clock ran out one level up. Returns the escalated ids. */
export function runAutoEscalation(d: Deps): string[] {
  const now = d.clock();
  const policy = d.policy ?? DEFAULT_POLICY;
  const open = all<Issue & { owner_role: Role }>(d.db,
    "SELECT i.*, u.role AS owner_role FROM issues i JOIN users u ON u.id = i.owner_id WHERE i.status IN ('open','in_progress')");
  const moved: string[] = [];
  for (const i of open) {
    if (i.owner_role === "COO") continue;
    const why = autoEscalation(i, now, policy);
    if (!why) continue;
    escalateIssue(d, null, i.id, REASON_TEXT[why](i, Math.round(minutesBetween(i.layer_since, now))));
    moved.push(i.id);
  }
  return moved;
}

export interface DueSummary {
  open: number; overdue: number; due_today: number; due_week: number; not_picked_up: number;
  closed_30d: number; on_time_pct: number | null; avg_days_late: number | null;
  /** One line per direct report (their whole subtree): who is keeping their dates. */
  by_manager: { user_id: string; name: string; role: Role; open: number; overdue: number; on_time_pct: number | null }[];
}

/** Due-date discipline for a person's perimeter, and per direct report. */
export function dueSummary(d: Deps, u: User): DueSummary {
  const now = d.clock();
  const nowIso = iso(now);
  const since = iso(new Date(now.getTime() - 30 * 86_400_000));
  const endToday = new Date(now); endToday.setUTCHours(23, 59, 59, 999);
  const week = new Date(now.getTime() + 7 * 86_400_000);

  const stats = (teamIds: string[]) => {
    if (!teamIds.length) return { open: 0, overdue: 0, due_today: 0, due_week: 0, not_picked_up: 0, closed_30d: 0, on_time_pct: null, avg_days_late: null };
    const inT = `team_id IN (${teamIds.map(() => "?").join(",")})`;
    const o = get<{ open: number; overdue: number; today: number; week: number; npu: number }>(d.db, `
      SELECT COUNT(*) AS open, SUM(due_at <= ?) AS overdue, SUM(due_at <= ?) AS today, SUM(due_at <= ?) AS week,
        SUM(acknowledged_at IS NULL) AS npu
      FROM issues WHERE ${inT} AND status IN ('open','in_progress')`, nowIso, iso(endToday), iso(week), ...teamIds)!;
    const c = get<{ n: number; on_time: number; late_days: number | null }>(d.db, `
      SELECT COUNT(*) AS n, SUM(resolved_at <= due_at) AS on_time,
        AVG(CASE WHEN resolved_at > due_at THEN julianday(resolved_at) - julianday(due_at) END) AS late_days
      FROM issues WHERE ${inT} AND resolved_at >= ?`, ...teamIds, since)!;
    return {
      open: o.open, overdue: o.overdue ?? 0, due_today: o.today ?? 0, due_week: o.week ?? 0, not_picked_up: o.npu ?? 0,
      closed_30d: c.n, on_time_pct: c.n ? Math.round(((c.on_time ?? 0) / c.n) * 1000) / 10 : null,
      avg_days_late: c.late_days == null ? null : Math.round(c.late_days * 10) / 10,
    };
  };

  const mine = stats([...visibleTeamIds(d.db, u)]);
  const reports = all<User>(d.db, "SELECT * FROM users WHERE manager_id = ? ORDER BY name", u.id);
  return {
    ...mine,
    by_manager: reports.map((r) => {
      const s = stats([...visibleTeamIds(d.db, r)]);
      return { user_id: r.id, name: r.name, role: r.role, open: s.open, overdue: s.overdue, on_time_pct: s.on_time_pct };
    }),
  };
}
