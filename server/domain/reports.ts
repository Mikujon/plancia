import { all, get } from "../db.ts";
import { actionsByKpi, exceptions, movers } from "./analysis.ts";
import { getIssue, dueSummary, type Deps } from "./issues.ts";
import { addInto, canSeeFinance, KPI, loadDaily, scorecard, trend, zero, type KpiCode, type Period, type ScoreNode } from "./kpi.ts";
import { campaigns, clients, teams, visibleCampaignIds, visibleTeamIds } from "./org.ts";
import { addDays, dayOf, minutesBetween } from "./time.ts";
import { DomainError, type Campaign, type User } from "./types.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;
export const fmtKpi = (code: KpiCode, v: number | null) => {
  if (v == null) return "—";
  const u = KPI[code].unit;
  return u === "s" ? `${Math.round(v)}s` : u === "€" ? `€${v.toFixed(2)}` : `${v.toFixed(1)}%`;
};

// ── single issue, floor to resolution ─────────────────────────────────────

export function issueReport(d: Deps, u: User | null, id: string) {
  const { issue, events, chain } = getIssue(d, u, id);
  const end = issue.resolved_at ?? d.clock().toISOString();
  const layers = chain.map((s) => ({ ...s, minutes: Math.round(minutesBetween(s.entered_at, s.left_at ?? end)) }));
  const c = campaigns(d.db).find((x) => x.id === issue.campaign_id)!;
  const day = issue.created_at.slice(0, 10);
  const data = loadDaily(d.db, day, dayOf(addDays(new Date(day), 1)));
  const a = zero();
  for (const t of teams(d.db).filter((t) => t.campaign_id === c.id)) { const x = data.get(t.id)?.get(day); if (x) addInto(a, x); }
  const dayMargin = a.revenue ? r2(a.revenue - a.labour_cost - a.sla_penalty) : null;
  return {
    issue, events, chain: layers,
    time_to_resolve_min: issue.resolved_at ? Math.round(minutesBetween(issue.created_at, issue.resolved_at)) : null,
    open_for_min: Math.round(minutesBetween(issue.created_at, end)),
    escalations: events.filter((e) => e.type === "escalated").length,
    auto_escalations: events.filter((e) => e.type === "escalated" && !e.actor_id).length,
    due_changes: Math.max(0, events.filter((e) => e.type === "due").length - 1),
    on_time: issue.resolved_at ? issue.resolved_at <= issue.due_at : null,
    cost: {
      type: issue.impact_type, hours: issue.impact_hours, amount: issue.impact_amount,
      day_margin: dayMargin,
      share_of_day_margin_pct: dayMargin && dayMargin > 0 ? r2((issue.impact_amount / dayMargin) * 100) : null,
    },
    campaign: { id: c.id, name: c.name, billing_rate: c.billing_rate, hourly_cost: c.hourly_cost },
  };
}

// ── P&L by campaign ───────────────────────────────────────────────────────

export interface RollupRow {
  campaign_id: string; campaign_name: string; client_id: string; client_name: string;
  revenue: number; labour_cost: number; sla_penalty: number; margin: number; margin_pct: number;
  issue_cost: number; issues: number; sla_days_missed: number; days: number; open_issues: number; open_risk: number;
}

function scoped(d: Deps, u: User | null, clientId?: string): Campaign[] {
  const vis = u ? visibleCampaignIds(d.db, u) : null;
  return campaigns(d.db).filter((c) => (!vis || vis.has(c.id)) && (!clientId || c.client_id === clientId));
}

/** Revenue, labour, SLA penalties and margin per campaign — from the same daily rows the KPIs use. */
export function rollup(d: Deps, u: User | null, p: { from?: string; to?: string; client_id?: string } = {}) {
  const now = d.clock();
  const to = p.to ?? dayOf(now);
  const from = p.from ?? dayOf(addDays(now, -30));
  const cl = new Map(clients(d.db).map((c) => [c.id, c.name]));
  const data = loadDaily(d.db, from, to);
  const tt = teams(d.db);
  const rows: RollupRow[] = [];
  const daily = new Map<string, { date: string; revenue: number; margin: number; issue_cost: number; sla_penalty: number }>();

  for (const c of scoped(d, u, p.client_id)) {
    const byDay = new Map<string, ReturnType<typeof zero>>();
    for (const t of tt.filter((t) => t.campaign_id === c.id))
      for (const [date, a] of data.get(t.id) ?? []) byDay.set(date, addInto(byDay.get(date) ?? zero(), a));
    const issueCost = all<{ date: string; cost: number; n: number }>(d.db,
      `SELECT substr(created_at,1,10) AS date, SUM(impact_amount) AS cost, COUNT(*) AS n FROM issues
       WHERE campaign_id = ? AND created_at >= ? AND created_at < ? GROUP BY 1`, c.id, from, to + "T99");
    const open = get<{ n: number; risk: number }>(d.db,
      `SELECT COUNT(*) AS n, IFNULL(SUM(impact_amount),0) AS risk FROM issues WHERE campaign_id = ? AND status IN ('open','in_progress')`, c.id)!;
    const row: RollupRow = {
      campaign_id: c.id, campaign_name: c.name, client_id: c.client_id, client_name: cl.get(c.client_id) ?? "",
      revenue: 0, labour_cost: 0, sla_penalty: 0, margin: 0, margin_pct: 0,
      issue_cost: r2(issueCost.reduce((s, x) => s + x.cost, 0)), issues: issueCost.reduce((s, x) => s + x.n, 0),
      sla_days_missed: 0, days: byDay.size, open_issues: open.n, open_risk: r2(open.risk),
    };
    for (const [date, a] of byDay) {
      const margin = a.revenue - a.labour_cost - a.sla_penalty;
      row.revenue += a.revenue; row.labour_cost += a.labour_cost; row.sla_penalty += a.sla_penalty; row.margin += margin;
      if (a.sla_penalty > 0) row.sla_days_missed++;
      const agg = daily.get(date) ?? { date, revenue: 0, margin: 0, issue_cost: 0, sla_penalty: 0 };
      agg.revenue += a.revenue; agg.margin += margin; agg.sla_penalty += a.sla_penalty;
      daily.set(date, agg);
    }
    for (const ic of issueCost) { const agg = daily.get(ic.date); if (agg) agg.issue_cost += ic.cost; }
    for (const k of ["revenue", "labour_cost", "sla_penalty", "margin"] as const) row[k] = r2(row[k]);
    row.margin_pct = row.revenue ? r2((row.margin / row.revenue) * 100) : 0;
    rows.push(row);
  }
  const totals = rows.reduce((t, r) => ({
    revenue: t.revenue + r.revenue, labour_cost: t.labour_cost + r.labour_cost, sla_penalty: t.sla_penalty + r.sla_penalty,
    margin: t.margin + r.margin, issue_cost: t.issue_cost + r.issue_cost, open_risk: t.open_risk + r.open_risk,
    open_issues: t.open_issues + r.open_issues,
  }), { revenue: 0, labour_cost: 0, sla_penalty: 0, margin: 0, issue_cost: 0, open_risk: 0, open_issues: 0 });
  const lastDay = get<{ d: string }>(d.db, "SELECT MAX(date) AS d FROM kpi_daily")?.d ?? null;
  return {
    from, to, updated_through: lastDay, rows,
    totals: {
      revenue: r2(totals.revenue), labour_cost: r2(totals.labour_cost), sla_penalty: r2(totals.sla_penalty),
      margin: r2(totals.margin), issue_cost: r2(totals.issue_cost), open_risk: r2(totals.open_risk), open_issues: totals.open_issues,
      margin_pct: totals.revenue ? r2((totals.margin / totals.revenue) * 100) : 0,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({
      date: x.date, revenue: r2(x.revenue), margin: r2(x.margin), issue_cost: r2(x.issue_cost), sla_penalty: r2(x.sla_penalty),
      margin_pct: x.revenue ? r2((x.margin / x.revenue) * 100) : 0,
    })),
  };
}

// ── issue patterns (cost history) ─────────────────────────────────────────

export function patterns(d: Deps, u: User | null, p: { weeks?: number; campaign_id?: string } = {}) {
  const weeks = Math.min(p.weeks ?? 8, 26);
  const from = dayOf(addDays(d.clock(), -weeks * 7));
  const camps = scoped(d, u).filter((c) => !p.campaign_id || c.id === p.campaign_id).map((c) => c.id);
  if (!camps.length) return { from, weekly: [], by_team: [], by_weekday: [] };
  const inC = `campaign_id IN (${camps.map(() => "?").join(",")})`;
  const weekly = all<{ week: string; category: string; cost: number; n: number }>(d.db, `
    SELECT strftime('%Y-W%W', created_at) AS week, category, ROUND(SUM(impact_amount),2) AS cost, COUNT(*) AS n
    FROM issues WHERE ${inC} AND created_at >= ? GROUP BY 1, 2 ORDER BY 1`, ...camps, from);
  const by_team = all<{ team_id: string; team_name: string; cost: number; n: number; avg_resolve_min: number | null }>(d.db, `
    SELECT i.team_id, t.name AS team_name, ROUND(SUM(i.impact_amount),2) AS cost, COUNT(*) AS n,
      ROUND(AVG(CASE WHEN i.resolved_at IS NOT NULL THEN (julianday(i.resolved_at) - julianday(i.created_at)) * 1440 END)) AS avg_resolve_min
    FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.${inC} AND i.created_at >= ? GROUP BY 1 ORDER BY cost DESC`, ...camps, from);
  const by_weekday = all<{ weekday: number; category: string; n: number; cost: number }>(d.db, `
    SELECT CAST(strftime('%w', created_at) AS INTEGER) AS weekday, category, COUNT(*) AS n, ROUND(SUM(impact_amount),2) AS cost
    FROM issues WHERE ${inC} AND created_at >= ? GROUP BY 1, 2`, ...camps, from);
  return { from, weekly, by_team, by_weekday };
}

// ── daily ops report / weekly business review ─────────────────────────────

/**
 * The management report for a person's perimeter:
 * - day: yesterday, compared with the day before · week: last 7 closed days vs the 7 before.
 * Scorecard of the viewer and their direct reports, exceptions with drivers, movers,
 * due-date discipline, escalations — and finance for CSDM/COO.
 */
export function opsReport(d: Deps, u: User, kind: "day" | "week") {
  const now = d.clock();
  const to = dayOf(now);
  const period: Period = { from: dayOf(addDays(new Date(to), kind === "day" ? -1 : -7)), to };
  const tree = scorecard(d, u, period);
  const headline: KpiCode[] = ["sl", "abandon", "aht", "adherence", "absenteeism", "qa", "csat", ...(canSeeFinance(u) ? (["margin"] as KpiCode[]) : [])];
  const exc = exceptions(d, u, period);
  const mv = movers(d, u, period, 5);
  const due = dueSummary(d, u);
  const teamIds = [...visibleTeamIds(d.db, u)];
  const esc = teamIds.length ? get<{ n: number; auto: number | null }>(d.db, `
    SELECT COUNT(*) AS n, SUM(e.actor_id IS NULL) AS auto FROM issue_events e JOIN issues i ON i.id = e.issue_id
    WHERE e.type = 'escalated' AND e.at >= ? AND e.at < ? AND i.team_id IN (${teamIds.map(() => "?").join(",")})`,
    period.from, period.to + "T99", ...teamIds)! : { n: 0, auto: 0 };
  const byKpi = actionsByKpi(d, teamIds, period);

  const title = `${kind === "day" ? "Daily operations report" : "Weekly business review"} — ${tree.label}`;
  const rows = [tree, ...tree.children];
  const mark = (r: string) => (r === "red" ? " (R)" : r === "amber" ? " (A)" : "");
  const line = (n: ScoreNode) => `| ${n === tree ? `**${n.label}**` : `${n.name} · ${n.label}`} | ${headline.map((k) => {
    const v = n.kpis[k];
    return v ? `${fmtKpi(k, v.value)}${mark(v.rag)}` : "—";
  }).join(" | ")} |`;
  const markdown = [
    `# ${title}`,
    `Period ${period.from} → ${dayOf(addDays(new Date(period.to), -1))} · compared with the ${kind === "day" ? "previous day" : "previous 7 days"} · (R) off target, (A) near target`,
    "",
    "## Scorecard",
    `| | ${headline.map((k) => `${KPI[k].name} (target ${fmtKpi(k, tree.kpis[k]?.target ?? null)})`).join(" | ")} |`,
    `|---|${headline.map(() => "---:").join("|")}|`,
    ...rows.map(line),
    "",
    "## Exceptions",
    ...(exc.length ? exc.slice(0, 10).map((e) =>
      `- **${e.label}** — ${e.kpi_name} ${fmtKpi(e.kpi, e.value)} vs ${fmtKpi(e.kpi, e.target)}` +
      (e.drivers.length ? `; drivers: ${e.drivers.map((x) => x.text).join(", ")}` : "") +
      (e.open_action ? ` · action ${e.open_action.ref} (${e.open_action.owner_name}, due ${e.open_action.due_at.slice(0, 10)})` : " · **no action open**"))
      : ["- None: every KPI is on or near target."]),
    "",
    "## What moved",
    ...mv.declining.map((m) => `- Down: ${m.node_name} · ${m.kpi_name} ${fmtKpi(m.kpi, m.prev)} → ${fmtKpi(m.kpi, m.value)}`),
    ...mv.improving.map((m) => `- Up: ${m.node_name} · ${m.kpi_name} ${fmtKpi(m.kpi, m.prev)} → ${fmtKpi(m.kpi, m.value)}`),
    ...(mv.declining.length + mv.improving.length ? [] : ["- No significant change."]),
    "",
    "## Actions & due dates",
    `- Open ${due.open} · overdue **${due.overdue}** · due today ${due.due_today} · not picked up ${due.not_picked_up}`,
    `- Closed in the last 30 days: ${due.closed_30d}, on time ${due.on_time_pct ?? "—"}%${due.avg_days_late != null ? `, late ones by ${due.avg_days_late} days on average` : ""}`,
    `- Escalations this period: ${esc.n} (${esc.auto ?? 0} automatic)`,
    ...due.by_manager.map((m) => `- ${m.name} (${m.role}): ${m.open} open, ${m.overdue} overdue, on time ${m.on_time_pct ?? "—"}%`),
  ].join("\n");

  return {
    kind, title, period, headline,
    scorecard: rows.map((n) => ({ id: n.id, level: n.level, name: n.name, label: n.label, volume: n.volume, kpis: n.kpis })),
    exceptions: exc, movers: mv, due, escalations: { total: esc.n, auto: esc.auto ?? 0 }, actions_by_kpi: byKpi,
    finance: canSeeFinance(u) ? rollup(d, u, { from: period.from, to: period.to }).totals : null,
    markdown,
  };
}

// ── QBR for a client ──────────────────────────────────────────────────────

const CONTRACT: KpiCode[] = ["sl", "abandon", "asa", "aht", "fcr", "csat", "qa"];

/** Client-facing review: contract KPIs vs target by month, issues, incidents and what was done. Margin stays internal. */
export function qbr(d: Deps, u: User | null, p: { client_id: string; from?: string; to?: string }) {
  const client = clients(d.db).find((c) => c.id === p.client_id);
  if (!client) throw new DomainError(404, "NOT_FOUND", "Client not found");
  const camps = scoped(d, u, p.client_id);
  if (!camps.length) throw new DomainError(403, "FORBIDDEN", "Outside your perimeter");
  const now = d.clock();
  const to = p.to ?? dayOf(now);
  const from = p.from ?? dayOf(addDays(now, -90));
  const period = { from, to };
  const ids = camps.map((c) => c.id);
  const inC = `campaign_id IN (${ids.map(() => "?").join(",")})`;
  const tt = teams(d.db);

  const perCampaign = camps.map((c) => {
    const teamIds = tt.filter((t) => t.campaign_id === c.id).map((t) => t.id);
    return {
      campaign: { id: c.id, name: c.name },
      kpis: CONTRACT.map((k) => {
        const days = trend(d, teamIds, k, period, "day");
        return {
          kpi: k, name: KPI[k].name,
          months: trend(d, teamIds, k, period, "month"),
          days_on_target: days.filter((x) => x.rag === "green").length, days: days.length,
        };
      }),
    };
  });

  const totals = get<{ n: number; resolved: number; escalated: number; to_account: number; avg_min: number | null; on_time: number | null }>(d.db, `
    SELECT COUNT(*) AS n, SUM(status IN ('resolved','closed')) AS resolved,
      SUM(EXISTS (SELECT 1 FROM issue_events e WHERE e.issue_id = i.id AND e.type = 'escalated')) AS escalated,
      SUM(EXISTS (SELECT 1 FROM issue_events e WHERE e.issue_id = i.id AND e.type = 'escalated' AND e.to_value IN ('CSDM','COO'))) AS to_account,
      ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 1440 END)) AS avg_min,
      SUM(resolved_at <= due_at) AS on_time
    FROM issues i WHERE ${inC} AND created_at >= ? AND created_at < ?`, ...ids, from, to + "T99")!;
  const byCat = all<{ category: string; n: number; avg_min: number | null }>(d.db, `
    SELECT category, COUNT(*) AS n,
      ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 1440 END)) AS avg_min
    FROM issues WHERE ${inC} AND created_at >= ? AND created_at < ? GROUP BY 1 ORDER BY n DESC`, ...ids, from, to + "T99");
  const top = all<{ ref: string; title: string; category: string; resolution: string | null; status: string }>(d.db, `
    SELECT ref, title, category, resolution, status FROM issues
    WHERE ${inC} AND created_at >= ? AND created_at < ? AND severity IN ('critical','high')
    ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, impact_amount DESC LIMIT 5`, ...ids, from, to + "T99");
  const roll = rollup(d, u, { from, to, client_id: p.client_id });
  const h = (m: number | null) => (m == null ? "n/a" : m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h`);

  const markdown = [
    `# ${client.name} — Quarterly business review`,
    `Period: ${from} → ${to}`,
    "",
    ...perCampaign.flatMap((c) => [
      `## ${c.campaign.name}`,
      `| KPI | ${c.kpis[0].months.map((m) => m.period).join(" | ")} | Target | Days on target |`,
      `|---|${c.kpis[0].months.map(() => "---:").join("|")}|---:|---:|`,
      ...c.kpis.map((k) => `| ${k.name} | ${k.months.map((m) => fmtKpi(k.kpi, m.value)).join(" | ")} | ${fmtKpi(k.kpi, k.months.at(-1)?.target ?? null)} | ${k.days_on_target}/${k.days} |`),
      "",
    ]),
    "## Operational issues",
    `- ${totals.n} issues logged, ${totals.resolved} resolved, ${totals.on_time ?? 0} within their due date; average resolution ${h(totals.avg_min)}.`,
    `- ${totals.n - totals.escalated} of ${totals.n} handled by the team without escalation; ${totals.to_account} reached the account team.`,
    ...byCat.slice(0, 5).map((c) => `- ${c.category}: ${c.n} (average resolution ${h(c.avg_min)})`),
    "",
    "## Main incidents and actions taken",
    ...top.map((t) => `- **${t.ref} · ${t.title}** — ${t.resolution ?? "in progress"}`),
  ].join("\n");

  return {
    client, from, to, campaigns: perCampaign, totals, by_category: byCat, top_issues: top,
    // internal only — margin stays out of the client-facing markdown
    internal: { revenue: roll.totals.revenue, margin: roll.totals.margin, margin_pct: roll.totals.margin_pct, issue_cost: roll.totals.issue_cost, sla_penalty: roll.totals.sla_penalty },
    markdown,
  };
}
