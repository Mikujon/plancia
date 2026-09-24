import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import * as C from "../contracts/ops.v1.ts";
import {
  commentIssue, createIssue, dueSummary, escalateIssue, getIssue, listIssues, reopenIssue, resolveIssue, updateIssue,
} from "../domain/issues.ts";
import { campaigns, clients, floors, orgTree, teams, userById, users, visibleCampaignIds, visibleTeamIds } from "../domain/org.ts";
import { liveStaffing, manualStaffing, shifts } from "../domain/staffing.ts";
import { groups, inbox, mapGroup, messageToIssue, setFlag } from "../domain/chat.ts";
import { acknowledgeHandover, createHandover, listHandovers } from "../domain/handovers.ts";
import { issueReport, opsReport, patterns, qbr, rollup } from "../domain/reports.ts";
import { exceptions, league, movers } from "../domain/analysis.ts";
import { canSeeFinance, flatten, isKpi, KPIS, lastDays, scorecard, trend, type KpiCode, type Period } from "../domain/kpi.ts";
import { dayOf } from "../domain/time.ts";
import { DomainError, type User } from "../domain/types.ts";
import type { AppDeps } from "../app.ts";

type Env = { Variables: { user: User } };

function body<T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new DomainError(400, "INPUT", `${i.path.join(".") || "body"}: ${i.message}`);
  }
  return r.data;
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Due = z.iso.datetime();

/** ?from=&to= (to exclusive) or ?days=N (last N closed days, default 7); at most 92 days. */
function periodOf(q: Record<string, string>, now: Date): Period {
  if (q.from || q.to) {
    const from = Day.safeParse(q.from), to = Day.safeParse(q.to);
    if (!from.success || !to.success) throw new DomainError(400, "INPUT", "from and to must be YYYY-MM-DD");
    const days = (Date.parse(to.data) - Date.parse(from.data)) / 86_400_000;
    if (days <= 0 || days > 92) throw new DomainError(400, "INPUT", "Period must be 1 to 92 days");
    return { from: from.data, to: to.data };
  }
  const n = Number(q.days ?? 7);
  if (!Number.isInteger(n) || n < 1 || n > 92) throw new DomainError(400, "INPUT", "days must be 1 to 92");
  return lastDays(now, n);
}

function kpiOf(v: string | undefined): KpiCode {
  if (!v || !isKpi(v)) throw new DomainError(400, "INPUT", `kpi must be one of ${KPIS.map((k) => k.code).join(", ")}`);
  return v;
}

const Impact = {
  impact_type: C.ImpactType.optional(),
  impact_hours: z.number().nonnegative().max(10_000).optional(),
  impact_amount: z.number().nonnegative().max(10_000_000).nullable().optional(),
};

export function internalApi(d: AppDeps) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error("[api]", err);
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
  });

  // Demo sign-in: the UI sends the chosen person. Replace with SSO (Google Workspace) before go-live.
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/org" || c.req.path === "/api/stream") return next();
    const id = c.req.header("x-user-id");
    if (!id) return c.json({ error: { code: "AUTH", message: "Choose who you are" } }, 401);
    c.set("user", userById(d.db, id));
    await next();
  });

  app.get("/org", (c) => c.json({
    users: users(d.db), clients: clients(d.db), campaigns: campaigns(d.db), floors: floors(d.db),
    teams: teams(d.db), shifts: shifts(d.db), wfm: d.wfm.name, today: dayOf(d.clock()),
  }));

  app.get("/me", (c) => {
    const u = c.get("user");
    return c.json({ user: u, team_ids: [...visibleTeamIds(d.db, u)], campaign_ids: [...visibleCampaignIds(d.db, u)] });
  });

  app.get("/stream", (c) => streamSSE(c, async (s) => {
    let open = true;
    const off = d.bus.on((ch) => { if (open) void s.writeSSE({ event: "change", data: JSON.stringify(ch) }); });
    s.onAbort(() => { open = false; off(); });
    while (open) {
      await s.writeSSE({ event: "ping", data: String(Date.now()) });
      await s.sleep(25_000);
    }
  }));

  // ── issues ──
  app.get("/issues", (c) => {
    const q = c.req.query();
    return c.json(listIssues(d, c.get("user"), {
      campaign_id: q.campaign_id, client_id: q.client_id, team_id: q.team_id,
      status: (q.status as "open" | "resolved" | "all") ?? "open",
      layer: q.layer as User["role"] | undefined, owner_id: q.owner === "me" ? c.get("user").id : q.owner_id,
      category: q.category as never, kpi: q.kpi, q: q.q, from: q.from, to: q.to,
      due: q.due as "overdue" | "today" | "week" | undefined, limit: q.limit ? Number(q.limit) : undefined,
    }));
  });

  app.post("/issues", async (c) => {
    const p = body(z.object({
      team_id: z.string(), title: z.string().min(3).max(200), description: z.string().max(4000).optional(),
      category: C.Category, severity: C.Severity, sla_related: z.boolean().optional(), ...Impact,
      kpi: z.string().refine(isKpi, "unknown KPI").optional(), due_at: Due.optional(),
    }), await c.req.json());
    return c.json(createIssue(d, c.get("user"), { ...p, source: "floor" }), 201);
  });

  app.get("/issues/:id", (c) => c.json(getIssue(d, c.get("user"), c.req.param("id"))));
  app.get("/issues/:id/report", (c) => {
    const u = c.get("user");
    const r = issueReport(d, u, c.req.param("id"));
    // The floor layers see the cost of the issue, not the campaign's margin.
    if (u.role === "TL" || u.role === "FM") r.cost = { ...r.cost, day_margin: null, share_of_day_margin_pct: null };
    return c.json(r);
  });

  app.patch("/issues/:id", async (c) => {
    const p = body(z.object({
      title: z.string().min(3).max(200).optional(), description: z.string().max(4000).optional(),
      category: C.Category.optional(), severity: C.Severity.optional(), sla_related: z.boolean().optional(),
      status: z.enum(["open", "in_progress", "closed"]).optional(), owner_id: z.string().optional(), ...Impact,
      kpi: z.string().refine(isKpi, "unknown KPI").nullable().optional(),
      due_at: Due.optional(), due_reason: z.string().max(500).optional(),
    }), await c.req.json());
    return c.json(updateIssue(d, c.get("user"), c.req.param("id"), p));
  });

  app.post("/issues/:id/escalate", async (c) => {
    const p = body(z.object({ reason: z.string().min(3).max(1000) }), await c.req.json());
    return c.json(escalateIssue(d, c.get("user"), c.req.param("id"), p.reason));
  });

  app.post("/issues/:id/resolve", async (c) => {
    const p = body(z.object({ resolution: z.string().min(3).max(4000), ...Impact }), await c.req.json());
    return c.json(resolveIssue(d, c.get("user"), c.req.param("id"), p));
  });

  app.post("/issues/:id/reopen", async (c) => {
    const p = body(z.object({ note: z.string().min(3).max(1000) }), await c.req.json());
    return c.json(reopenIssue(d, c.get("user"), c.req.param("id"), p.note));
  });

  app.post("/issues/:id/comments", async (c) => {
    const p = body(z.object({ text: z.string().min(1).max(4000) }), await c.req.json());
    commentIssue(d, c.get("user"), c.req.param("id"), p.text);
    return c.json({ ok: true }, 201);
  });

  // ── staffing ──
  app.get("/staffing", async (c) => c.json(await liveStaffing(d, d.wfm, c.get("user"), { campaign_id: c.req.query("campaign_id") })));
  app.post("/staffing/manual", async (c) => {
    const p = body(z.object({
      team_id: z.string(), shift_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      scheduled: z.number().int().min(0).max(500), present: z.number().int().min(0).max(500),
    }), await c.req.json());
    manualStaffing(d, c.get("user"), p);
    return c.json({ ok: true }, 201);
  });

  // ── chat inbox ──
  app.get("/inbox", (c) => c.json(inbox(d, c.get("user"), { view: c.req.query("view") as "all" | "flagged" })));
  app.patch("/inbox/:id", async (c) => {
    const p = body(z.object({ flagged: z.boolean().optional(), dismissed: z.boolean().optional() }), await c.req.json());
    setFlag(d, c.get("user"), c.req.param("id"), p);
    return c.json({ ok: true });
  });
  app.post("/inbox/:id/issue", async (c) => {
    const p = body(z.object({
      title: z.string().max(200).optional(), category: C.Category.optional(), severity: C.Severity.optional(), layer: C.Layer.optional(),
    }), await c.req.json().catch(() => ({})));
    return c.json(messageToIssue(d, c.get("user"), c.req.param("id"), p), 201);
  });

  // ── handovers ──
  app.get("/handovers", (c) => c.json(listHandovers(d, c.get("user"), {
    team_id: c.req.query("team_id"), q: c.req.query("q"), from: c.req.query("from"), limit: Number(c.req.query("limit") ?? 50),
  })));
  app.post("/handovers", async (c) => {
    const p = body(z.object({
      team_id: z.string(), shift_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().min(3).max(8000), headcount_note: z.string().max(1000).optional(), issue_ids: z.array(z.string()).optional(),
    }), await c.req.json());
    return c.json({ id: createHandover(d, c.get("user"), p) }, 201);
  });
  app.post("/handovers/:id/ack", (c) => {
    acknowledgeHandover(d, c.get("user"), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── hierarchy ──
  app.get("/org/tree", (c) => c.json(orgTree(d.db, c.get("user").id)));

  // ── KPIs ──
  app.get("/kpis/definitions", (c) => {
    const fin = canSeeFinance(c.get("user"));
    return c.json(KPIS.filter((k) => fin || !k.finance).map(({ value: _v, weight: _w, ...k }) => k));
  });
  app.get("/kpis/scorecard", (c) => c.json(scorecard(d, c.get("user"), periodOf(c.req.query(), d.clock()))));
  app.get("/kpis/trend", (c) => {
    const q = c.req.query();
    const u = c.get("user");
    const kpi = kpiOf(q.kpi);
    if (!canSeeFinance(u) && KPIS.find((k) => k.code === kpi)!.finance) throw new DomainError(403, "FORBIDDEN", "Finance KPIs are for CSDM and COO");
    const period = periodOf(q, d.clock());
    // node = a person in your tree (their whole subtree) or a team id
    const node = q.node ? flatten(scorecard(d, u, period)).find((n) => n.id === q.node) : null;
    if (q.node && !node) throw new DomainError(404, "NOT_FOUND", "Not in your perimeter");
    const ids = node ? node.team_ids : [...visibleTeamIds(d.db, u)];
    return c.json(trend(d, ids, kpi, period, (q.grain as "day" | "week" | "month") ?? "day"));
  });

  // ── analysis ──
  app.get("/analysis/exceptions", (c) => c.json(exceptions(d, c.get("user"), periodOf(c.req.query(), d.clock()))));
  app.get("/analysis/movers", (c) => c.json(movers(d, c.get("user"), periodOf(c.req.query(), d.clock()))));
  app.get("/analysis/league", (c) => {
    const q = c.req.query();
    return c.json(league(d, c.get("user"), periodOf(q, d.clock()), kpiOf(q.kpi), q.level === "FM" ? "FM" : "team"));
  });

  // ── actions & due dates ──
  app.get("/actions/due", (c) => c.json(dueSummary(d, c.get("user"))));

  // ── reports ──
  app.get("/reports/ops", (c) => c.json(opsReport(d, c.get("user"), c.req.query("kind") === "week" ? "week" : "day")));
  // Margin and client-facing numbers belong to the account layers.
  const accountOnly = (u: User) => {
    if (u.role !== "CSDM" && u.role !== "COO") throw new DomainError(403, "FORBIDDEN", "Margin reports are for CSDM and COO");
  };
  app.get("/rollup", (c) => { accountOnly(c.get("user")); return c.json(rollup(d, c.get("user"), c.req.query())); });
  app.get("/patterns", (c) => c.json(patterns(d, c.get("user"), { weeks: Number(c.req.query("weeks") ?? 8), campaign_id: c.req.query("campaign_id") })));
  app.get("/qbr", (c) => {
    const q = c.req.query();
    accountOnly(c.get("user"));
    if (!q.client_id) throw new DomainError(400, "INPUT", "client_id is required");
    return c.json(qbr(d, c.get("user"), { client_id: q.client_id, from: q.from, to: q.to }));
  });

  // ── integrations ──
  app.get("/integrations", (c) => c.json({
    groups: groups(d.db),
    wfm: d.wfm.name,
    api: { version: C.OPS_CONTRACT_VERSION, methods: C.OPS_METHODS, limits: C.OPS_LIMITS, tokens_configured: d.apiTokens.length },
    webhooks: {
      telegram: { path: "/webhooks/telegram", secret_configured: Boolean(d.telegramSecret) },
      google_chat: { path: "/webhooks/google-chat", token_configured: Boolean(d.googleChatToken) },
    },
  }));

  app.post("/chat/groups", async (c) => {
    const u = c.get("user");
    if (u.role === "TL") throw new DomainError(403, "FORBIDDEN", "Floor Managers and above map chat groups");
    const p = body(z.object({
      source: z.enum(["google_chat", "telegram"]), external_id: z.string().min(1), name: z.string().min(1), team_id: z.string(),
    }), await c.req.json());
    return c.json(mapGroup(d, p), 201);
  });

  return app;
}
