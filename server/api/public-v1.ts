import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { all, get } from "../db.ts";
import * as C from "../contracts/ops.v1.ts";
import { createIssue, getIssue, issueRow, type IssueRow } from "../domain/issues.ts";
import { campaigns, clients, teams } from "../domain/org.ts";
import { rollup } from "../domain/reports.ts";
import { liveStaffing } from "../domain/staffing.ts";
import { listHandovers } from "../domain/handovers.ts";
import { scorecard, type ScoreNode } from "../domain/kpi.ts";
import { DomainError, type User } from "../domain/types.ts";
import type { AppDeps } from "../app.ts";

const V = C.OPS_CONTRACT_VERSION;

type Code = z.infer<typeof C.ErrorCode>;
const fail = (c: Context, status: 400 | 401 | 404 | 409 | 500, code: Code, message: string) =>
  c.json({ version: V, error: { code, message } }, status);

/** Opaque to callers. Today it's base64url JSON; it may change without notice. */
const encodeCursor = (k: unknown[]) => Buffer.from(JSON.stringify(k)).toString("base64url");
function decodeCursor(s: string): string[] {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string")) return v;
  } catch { /* fallthrough */ }
  throw new DomainError(400, "INPUT", "Invalid cursor");
}

function tokenOk(header: string | undefined, tokens: string[]) {
  const got = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!got) return false;
  const a = Buffer.from(got);
  return tokens.some((t) => {
    const b = Buffer.from(t);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

const toIssue = (r: IssueRow): C.TIssue => ({
  id: r.id, ref: r.ref, campaign_id: r.campaign_id, client_id: r.client_id, team_id: r.team_id,
  title: r.title, category: r.category, severity: r.severity, status: r.status, layer: r.layer,
  owner: { id: r.owner_id, name: r.owner_name, role: r.owner_role }, sla_related: r.sla_related === 1,
  source: r.source, impact: { type: r.impact_type, hours: r.impact_hours, amount_eur: r.impact_amount },
  created_at: r.created_at, updated_at: r.updated_at, resolved_at: r.resolved_at,
  due_at: r.due_at, due_state: r.due_state, kpi: r.kpi, escalates_in_min: r.escalates_in_min,
});

export function publicApi(d: AppDeps) {
  const app = new Hono();
  const observed = () => d.clock().toISOString();

  /** Every response is checked against the contract before it leaves; a mismatch never ships. */
  function send<T extends z.ZodTypeAny>(c: Context, schema: T, body: unknown, status: 200 | 201 = 200) {
    const out = schema.safeParse(body);
    if (!out.success) {
      console.error("[ops.v1] response broke the contract", out.error.issues.slice(0, 3));
      return fail(c, 500, "OPS-500-INTERNAL", "Response did not match the contract");
    }
    return c.json(out.data, status);
  }

  function params<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
    const r = schema.safeParse(input);
    if (!r.success) {
      const i = r.error.issues[0];
      throw new DomainError(400, "INPUT", `${i.path.join(".") || "params"}: ${i.message}`);
    }
    return r.data;
  }

  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/manifest")) return next();
    if (!tokenOk(c.req.header("authorization"), d.apiTokens)) return fail(c, 401, "OPS-401-AUTH", "Missing or invalid bearer token");
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      const map = { 400: "OPS-400-INPUT", 403: "OPS-404-NOT_FOUND", 404: "OPS-404-NOT_FOUND", 409: "OPS-409-CONFLICT" } as const;
      return fail(c, err.status === 403 ? 404 : err.status, map[err.status], err.message);
    }
    console.error("[ops.v1]", err);
    return fail(c, 500, "OPS-500-INTERNAL", "Internal error");
  });

  app.get("/manifest", (c) => c.json({ version: V, limits: C.OPS_LIMITS, methods: C.OPS_METHODS, auth: "Bearer token" }));

  app.get("/campaigns", (c) => {
    const cl = new Map(clients(d.db).map((x) => [x.id, x]));
    const ts = teams(d.db);
    const items = campaigns(d.db).map((x) => ({
      id: x.id, code: x.code, name: x.name, client: { id: x.client_id, name: cl.get(x.client_id)!.name },
      sla_target_pct: x.sla_target_pct,
      teams: ts.filter((t) => t.campaign_id === x.id).map((t) => ({ id: t.id, name: t.name, floor_id: t.floor_id })),
    }));
    return send(c, C.Page(C.Campaign), { version: V, observed_at: observed(), items, next_cursor: null });
  });

  app.get("/issues", (c) => {
    const p = params(C.ListIssuesParams, c.req.query());
    const where: string[] = [];
    const args: string[] = [];
    if (p.campaign_id) { where.push("i.campaign_id = ?"); args.push(p.campaign_id); }
    if (p.client_id) { where.push("c.client_id = ?"); args.push(p.client_id); }
    if (p.status === "open") where.push("i.status IN ('open','in_progress')");
    if (p.status === "resolved") where.push("i.status IN ('resolved','closed')");
    if (p.layer) { where.push("i.layer = ?"); args.push(p.layer); }
    if (p.updated_since) { where.push("i.updated_at >= ?"); args.push(p.updated_since); }
    if (p.cursor) {
      const [u, id] = decodeCursor(p.cursor);
      where.push("(i.updated_at > ? OR (i.updated_at = ? AND i.id > ?))");
      args.push(u, u, id);
    }
    const rows = all<{ id: string; updated_at: string }>(d.db,
      `SELECT i.id, i.updated_at FROM issues i JOIN campaigns c ON c.id = i.campaign_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.updated_at, i.id LIMIT ?`, ...args, p.limit + 1);
    const page = rows.slice(0, p.limit);
    const last = page.at(-1);
    return send(c, C.Page(C.Issue), {
      version: V, observed_at: observed(),
      items: page.map((r) => toIssue(issueRow(d, r.id))),
      next_cursor: rows.length > p.limit && last ? encodeCursor([last.updated_at, last.id]) : null,
    });
  });

  app.get("/issues/:id", (c) => {
    const { issue, events, chain } = getIssue(d, null, c.req.param("id"));
    const end = issue.resolved_at ?? observed();
    const detail: C.TIssueDetail = {
      ...toIssue(issue), description: issue.description, resolution: issue.resolution,
      chain: chain.map((s) => ({
        layer: s.layer, owner: { id: s.owner_id, name: s.owner_name }, entered_at: s.entered_at, left_at: s.left_at,
        minutes: Math.round((Date.parse(s.left_at ?? end) - Date.parse(s.entered_at)) / 60_000), how: s.how,
      })),
      events: events.map((e) => ({ at: e.at, type: e.type, actor: e.actor_name, from: e.from_value, to: e.to_value, note: e.note })),
    };
    return send(c, C.Envelope(C.IssueDetail), { version: V, observed_at: observed(), data: detail });
  });

  app.post("/issues", async (c) => {
    const body = await c.req.json().catch(() => { throw new DomainError(400, "INPUT", "Body must be JSON"); });
    const p = params(C.CreateIssueParams, body);
    if (!get(d.db, "SELECT 1 FROM teams WHERE id = ?", p.team_id)) throw new DomainError(400, "INPUT", "team_id: unknown team");
    if (p.external_ref) {
      const dup = get<{ id: string }>(d.db, "SELECT id FROM issues WHERE source = 'nodo' AND source_ref = ?", p.external_ref);
      if (dup) throw new DomainError(409, "CONFLICT", `external_ref already used by issue ${dup.id}`);
    }
    const i = createIssue(d, null as User | null, {
      team_id: p.team_id, title: p.title, description: p.description, category: p.category, severity: p.severity,
      sla_related: p.sla_related, impact_type: p.impact_type, impact_hours: p.impact_hours, impact_amount: p.impact_amount,
      source: "nodo", source_ref: p.external_ref ?? null, layer: "TL", due_at: p.due_at,
    });
    return send(c, C.Envelope(C.Issue), { version: V, observed_at: observed(), data: toIssue(issueRow(d, i.id)) }, 201);
  });

  app.get("/staffing", async (c) => {
    const p = params(C.StaffingParams, c.req.query());
    const rows = await liveStaffing(d, d.wfm, null, p);
    const items: C.TStaffingLine[] = rows.map((r) => ({
      campaign_id: r.campaign_id, team_id: r.team_id, date: r.date, shift_id: r.shift_id, shift_name: r.shift_name,
      required: r.required, scheduled: r.scheduled, present: r.present, gap: r.gap, gap_pct: r.gap_pct,
      hours_left: r.hours_left, gap_cost_eur: r.gap_cost, at_risk: r.at_risk, source: r.source, read_at: r.observed_at,
    }));
    return send(c, C.Page(C.StaffingLine), { version: V, observed_at: observed(), items, next_cursor: null });
  });

  app.get("/cost-rollup", (c) => {
    const p = params(C.CostRollupParams, c.req.query());
    const r = rollup(d, null, p);
    return send(c, C.Envelope(C.CostRollup), {
      version: V, observed_at: observed(),
      data: {
        from: r.from, to: r.to, updated_through: r.updated_through,
        lines: r.rows.map((x) => ({
          campaign_id: x.campaign_id, client_id: x.client_id, revenue_eur: x.revenue, labour_cost_eur: x.labour_cost,
          sla_penalty_eur: x.sla_penalty, margin_eur: x.margin, margin_pct: x.margin_pct, issue_cost_eur: x.issue_cost,
          issues: x.issues, sla_days_missed: x.sla_days_missed, days: x.days, open_issues: x.open_issues, open_risk_eur: x.open_risk,
        })),
      },
    });
  });

  app.get("/handovers", (c) => {
    const p = params(C.ListHandoversParams, c.req.query());
    const coo = get<User>(d.db, "SELECT * FROM users WHERE role = 'COO' LIMIT 1")!;
    let rows = listHandovers(d, coo, { team_id: p.team_id, from: p.from, limit: 500 });
    if (p.cursor) {
      const [at, id] = decodeCursor(p.cursor);
      rows = rows.filter((h) => h.created_at < at || (h.created_at === at && h.id < id));
    }
    rows.sort((a, b) => (b.created_at.localeCompare(a.created_at)) || b.id.localeCompare(a.id));
    const page = rows.slice(0, p.limit);
    const last = page.at(-1);
    return send(c, C.Page(C.Handover), {
      version: V, observed_at: observed(),
      items: page.map((h) => ({
        id: h.id, team_id: h.team_id, campaign_id: h.campaign_id, date: h.date, shift_id: h.shift_id,
        author: { id: h.author_id, name: h.author_name }, notes: h.notes, headcount_note: h.headcount_note,
        acknowledged_at: h.acknowledged_at, created_at: h.created_at, issue_refs: h.issues.map((i) => i.ref),
      })),
      next_cursor: rows.length > p.limit && last ? encodeCursor([last.created_at, last.id]) : null,
    });
  });

  app.get("/kpis", (c) => {
    const p = params(C.KpiScorecardParams, c.req.query());
    const coo = get<User>(d.db, "SELECT * FROM users WHERE role = 'COO' AND manager_id IS NULL LIMIT 1")!;
    const rows: z.infer<typeof C.ScorecardNode>[] = [];
    const walk = (n: ScoreNode, parent: string | null) => {
      rows.push({ id: n.id, parent_id: parent, level: n.level, name: n.name, label: n.label, team_ids: n.team_ids, volume: n.volume, kpis: n.kpis });
      n.children.forEach((ch) => walk(ch, n.id));
    };
    walk(scorecard(d, coo, p), null);
    return send(c, C.Page(C.ScorecardNode), { version: V, observed_at: observed(), items: rows, next_cursor: null });
  });

  app.notFound((c) => fail(c, 404, "OPS-404-NOT_FOUND", "Unknown method"));
  return app;
}
