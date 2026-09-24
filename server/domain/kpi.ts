import { all, type DB } from "../db.ts";
import type { Deps } from "./issues.ts";
import { campaigns, clients, orgTree, teams, teamsUnder, visibleTeamIds, type OrgNode } from "./org.ts";
import { addDays, dayOf } from "./time.ts";
import type { Campaign, Role, User } from "./types.ts";

/**
 * BPO KPI engine.
 *
 * Every KPI is a ratio of sums over `kpi_daily` rows (one per team per day). So any node of the
 * hierarchy — team, Floor Manager, CSDM account, COO — is computed by summing the raw counts of the
 * teams below it and applying the formula once. Never an average of averages: a 50-contact team
 * can't move the account's service level as much as a 5,000-contact one.
 */

export interface Agg {
  offered: number; forecast: number; answered: number; answered_in_sl: number; abandoned: number;
  handle_hours: number; wait_hours: number; paid_hours: number; logged_hours: number; required_hours: number;
  adherent_hours: number; absent_hours: number; overtime_hours: number;
  fcr_yes: number; fcr_n: number; csat_pos: number; csat_n: number; qa_points: number; qa_n: number;
  headcount: number; leavers: number;
  revenue: number; labour_cost: number; sla_penalty: number;
}

export const zero = (): Agg => ({
  offered: 0, forecast: 0, answered: 0, answered_in_sl: 0, abandoned: 0, handle_hours: 0, wait_hours: 0,
  paid_hours: 0, logged_hours: 0, required_hours: 0, adherent_hours: 0, absent_hours: 0, overtime_hours: 0,
  fcr_yes: 0, fcr_n: 0, csat_pos: 0, csat_n: 0, qa_points: 0, qa_n: 0, headcount: 0, leavers: 0,
  revenue: 0, labour_cost: 0, sla_penalty: 0,
});

export function addInto(a: Agg, b: Agg): Agg {
  for (const k of Object.keys(a) as (keyof Agg)[]) a[k] += b[k];
  return a;
}

export type KpiCode =
  | "sl" | "abandon" | "asa" | "aht" | "occupancy" | "adherence" | "shrinkage" | "absenteeism" | "attrition"
  | "fcr" | "csat" | "qa" | "forecast_var" | "coverage" | "cost_per_contact" | "margin";

export interface KpiDef {
  code: KpiCode; name: string; unit: "%" | "s" | "€";
  /** "band": on target within ±amber, e.g. occupancy — too high burns agents out, too low wastes paid time. */
  better: "higher" | "lower" | "band";
  group: "Service" | "Efficiency" | "Workforce" | "Quality" | "Finance";
  /** Finance KPIs are shown to CSDM and COO only. */
  finance: boolean;
  formula: string;
  value: (a: Agg) => number | null;
  /** The denominator — used to weight targets when campaigns are combined. */
  weight: (a: Agg) => number;
  target: number; amber: number;
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);

export const KPIS: KpiDef[] = [
  { code: "sl", name: "Service level", unit: "%", better: "higher", group: "Service", finance: false,
    formula: "answered within threshold ÷ offered", value: (a) => pct(a.answered_in_sl, a.offered), weight: (a) => a.offered, target: 80, amber: 5 },
  { code: "abandon", name: "Abandon rate", unit: "%", better: "lower", group: "Service", finance: false,
    formula: "abandoned ÷ offered", value: (a) => pct(a.abandoned, a.offered), weight: (a) => a.offered, target: 5, amber: 2 },
  { code: "asa", name: "ASA", unit: "s", better: "lower", group: "Service", finance: false,
    formula: "total queue wait ÷ answered", value: (a) => (a.answered ? (a.wait_hours * 3600) / a.answered : null), weight: (a) => a.answered, target: 30, amber: 10 },
  { code: "aht", name: "AHT", unit: "s", better: "lower", group: "Efficiency", finance: false,
    formula: "(talk + hold + after-call work) ÷ answered", value: (a) => (a.answered ? (a.handle_hours * 3600) / a.answered : null), weight: (a) => a.answered, target: 360, amber: 20 },
  { code: "occupancy", name: "Occupancy", unit: "%", better: "band", group: "Efficiency", finance: false,
    formula: "handle time ÷ logged-in time", value: (a) => pct(a.handle_hours, a.logged_hours), weight: (a) => a.logged_hours, target: 85, amber: 5 },
  { code: "adherence", name: "Schedule adherence", unit: "%", better: "higher", group: "Workforce", finance: false,
    formula: "time in adherence ÷ scheduled time worked", value: (a) => pct(a.adherent_hours, a.logged_hours), weight: (a) => a.logged_hours, target: 92, amber: 3 },
  { code: "shrinkage", name: "Shrinkage", unit: "%", better: "lower", group: "Workforce", finance: false,
    formula: "(paid − logged-in) ÷ paid", value: (a) => pct(a.paid_hours - a.logged_hours, a.paid_hours), weight: (a) => a.paid_hours, target: 30, amber: 3 },
  { code: "absenteeism", name: "Absenteeism", unit: "%", better: "lower", group: "Workforce", finance: false,
    formula: "unplanned absence ÷ paid", value: (a) => pct(a.absent_hours, a.paid_hours), weight: (a) => a.paid_hours, target: 6, amber: 2 },
  { code: "attrition", name: "Attrition (monthly)", unit: "%", better: "lower", group: "Workforce", finance: false,
    formula: "leavers ÷ average headcount, per month", value: (a) => pct(a.leavers, a.headcount), weight: (a) => a.headcount, target: 3, amber: 1 },
  { code: "coverage", name: "Staffing vs requirement", unit: "%", better: "band", group: "Workforce", finance: false,
    formula: "logged-in hours ÷ hours WFM required", value: (a) => pct(a.logged_hours, a.required_hours), weight: (a) => a.required_hours, target: 100, amber: 5 },
  { code: "forecast_var", name: "Volume vs forecast", unit: "%", better: "band", group: "Workforce", finance: false,
    formula: "(offered − forecast) ÷ forecast", value: (a) => pct(a.offered - a.forecast, a.forecast), weight: (a) => a.forecast, target: 0, amber: 5 },
  { code: "fcr", name: "First contact resolution", unit: "%", better: "higher", group: "Quality", finance: false,
    formula: "resolved first time ÷ surveyed", value: (a) => pct(a.fcr_yes, a.fcr_n), weight: (a) => a.fcr_n, target: 75, amber: 5 },
  { code: "csat", name: "CSAT", unit: "%", better: "higher", group: "Quality", finance: false,
    formula: "satisfied ÷ responses", value: (a) => pct(a.csat_pos, a.csat_n), weight: (a) => a.csat_n, target: 85, amber: 3 },
  { code: "qa", name: "QA score", unit: "%", better: "higher", group: "Quality", finance: false,
    formula: "audit points ÷ audits", value: (a) => (a.qa_n ? a.qa_points / a.qa_n : null), weight: (a) => a.qa_n, target: 88, amber: 3 },
  { code: "cost_per_contact", name: "Cost per contact", unit: "€", better: "lower", group: "Finance", finance: true,
    formula: "labour cost ÷ answered", value: (a) => (a.answered ? a.labour_cost / a.answered : null), weight: (a) => a.answered, target: 2, amber: 0.2 },
  { code: "margin", name: "Gross margin", unit: "%", better: "higher", group: "Finance", finance: true,
    formula: "(revenue − labour − SLA penalties) ÷ revenue", value: (a) => pct(a.revenue - a.labour_cost - a.sla_penalty, a.revenue), weight: (a) => a.revenue, target: 30, amber: 5 },
];
export const KPI = Object.fromEntries(KPIS.map((k) => [k.code, k])) as Record<KpiCode, KpiDef>;
export const isKpi = (s: string): s is KpiCode => s in KPI;

export type Rag = "green" | "amber" | "red" | "none";

export function rag(def: Pick<KpiDef, "better">, value: number | null, target: number, amber: number): Rag {
  if (value == null) return "none";
  const gap = def.better === "higher" ? target - value : def.better === "lower" ? value - target : Math.abs(value - target);
  if (def.better === "band") return gap <= amber ? "green" : gap <= amber * 2 ? "amber" : "red";
  return gap <= 0 ? "green" : gap <= amber ? "amber" : "red";
}

/** How far off target, in "amber bands" — 0 on target, 1 at the amber edge, >1 red. Used to rank exceptions. */
export function severityOf(def: Pick<KpiDef, "better">, value: number, target: number, amber: number) {
  const gap = def.better === "higher" ? target - value : def.better === "lower" ? value - target : Math.abs(value - target) - amber;
  return Math.max(0, gap) / (amber || 1);
}

// ── loading ────────────────────────────────────────────────────────────────

interface Row extends Omit<Agg, "headcount" | "leavers" | "revenue" | "labour_cost" | "sla_penalty"> { date: string; team_id: string }

export type Targets = Map<string, { target: number; amber: number }>; // key `${campaign}|${kpi}`

export function loadTargets(db: DB): Targets {
  const m: Targets = new Map();
  for (const c of campaigns(db)) {
    for (const k of KPIS) m.set(`${c.id}|${k.code}`, { target: k.code === "sl" ? c.sla_target_pct : k.target, amber: k.amber });
  }
  for (const t of all<{ campaign_id: string; kpi: string; target: number; amber: number }>(db, "SELECT * FROM kpi_targets"))
    m.set(`${t.campaign_id}|${t.kpi}`, { target: t.target, amber: t.amber });
  return m;
}

/**
 * Per-team, per-day aggregates for a date range [from, to), with finance attached:
 * revenue = logged-in hours × billing rate; labour = paid × cost + overtime × cost × OT multiplier;
 * the SLA penalty is decided on the campaign's whole day and shared across its teams by offered volume.
 */
export function loadDaily(db: DB, from: string, to: string): Map<string, Map<string, Agg>> {
  const rows = all<Row>(db, "SELECT * FROM kpi_daily WHERE date >= ? AND date < ?", from, to);
  const camp = new Map(campaigns(db).map((c) => [c.id, c]));
  const teamCamp = new Map(teams(db).map((t) => [t.id, camp.get(t.campaign_id)!]));
  // campaign-day service level, for the penalty
  const cd = new Map<string, { sl: number; off: number }>();
  for (const r of rows) {
    const k = `${teamCamp.get(r.team_id)!.id}|${r.date}`;
    const x = cd.get(k) ?? { sl: 0, off: 0 };
    x.sl += r.answered_in_sl; x.off += r.offered;
    cd.set(k, x);
  }
  const out = new Map<string, Map<string, Agg>>(); // team → date → agg
  for (const r of rows) {
    const c = teamCamp.get(r.team_id)!;
    const day = cd.get(`${c.id}|${r.date}`)!;
    const missed = day.off > 0 && (day.sl / day.off) * 100 < c.sla_target_pct;
    const a: Agg = {
      ...zero(),
      offered: r.offered, forecast: r.forecast, answered: r.answered, answered_in_sl: r.answered_in_sl, abandoned: r.abandoned,
      handle_hours: r.handle_hours, wait_hours: r.wait_hours, paid_hours: r.paid_hours, logged_hours: r.logged_hours,
      required_hours: r.required_hours, adherent_hours: r.adherent_hours, absent_hours: r.absent_hours, overtime_hours: r.overtime_hours,
      fcr_yes: r.fcr_yes, fcr_n: r.fcr_n, csat_pos: r.csat_pos, csat_n: r.csat_n, qa_points: r.qa_points, qa_n: r.qa_n,
      revenue: r.logged_hours * c.billing_rate,
      labour_cost: r.paid_hours * c.hourly_cost + r.overtime_hours * c.hourly_cost * c.overtime_multiplier,
      sla_penalty: missed ? c.sla_penalty_per_day * (r.offered / day.off) : 0,
    };
    if (!out.has(r.team_id)) out.set(r.team_id, new Map());
    out.get(r.team_id)!.set(r.date, a);
  }
  return out;
}

/** Headcount and leavers for the months a range touches (attrition is a monthly measure). */
function loadHeadcount(db: DB, from: string, to: string): Map<string, { headcount: number; leavers: number }> {
  const rows = all<{ team_id: string; headcount: number; leavers: number }>(db,
    "SELECT team_id, SUM(headcount) AS headcount, SUM(leavers) AS leavers FROM headcount_monthly WHERE month >= ? AND month <= ? GROUP BY team_id",
    from.slice(0, 7), dayOf(addDays(new Date(to), -1)).slice(0, 7));
  return new Map(rows.map((r) => [r.team_id, { headcount: r.headcount, leavers: r.leavers }]));
}

export interface PeriodData { from: string; to: string; byTeam: Map<string, Agg>; daily: Map<string, Map<string, Agg>> }

export function loadPeriod(db: DB, from: string, to: string): PeriodData {
  const daily = loadDaily(db, from, to);
  const hc = loadHeadcount(db, from, to);
  const byTeam = new Map<string, Agg>();
  for (const t of teams(db)) {
    const a = zero();
    for (const d of daily.get(t.id)?.values() ?? []) addInto(a, d);
    const h = hc.get(t.id);
    if (h) { a.headcount = h.headcount; a.leavers = h.leavers; }
    byTeam.set(t.id, a);
  }
  return { from, to, byTeam, daily };
}

export function sumTeams(data: Map<string, Agg>, teamIds: Iterable<string>): Agg {
  const a = zero();
  for (const id of teamIds) { const x = data.get(id); if (x) addInto(a, x); }
  return a;
}

// ── evaluation ─────────────────────────────────────────────────────────────

export interface KpiValue { value: number | null; target: number; amber: number; rag: Rag; prev: number | null; delta: number | null }

/** A node's target for a KPI: the campaigns' targets weighted by each campaign's own denominator. */
export function nodeTarget(def: KpiDef, perCampaign: { campaign: Campaign; agg: Agg }[], targets: Targets) {
  let w = 0, t = 0, am = 0;
  for (const { campaign, agg } of perCampaign) {
    const x = targets.get(`${campaign.id}|${def.code}`) ?? { target: def.target, amber: def.amber };
    const weight = Math.max(def.weight(agg), 1e-9);
    w += weight; t += x.target * weight; am += x.amber * weight;
  }
  return w ? { target: t / w, amber: am / w } : { target: def.target, amber: def.amber };
}

const round = (n: number | null, dp = 1) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

export function evaluate(teamIds: string[], cur: PeriodData, prev: PeriodData | null, db: DB, targets: Targets, showFinance: boolean) {
  const byCamp = new Map<string, string[]>();
  const tt = new Map(teams(db).map((t) => [t.id, t]));
  for (const id of teamIds) {
    const c = tt.get(id)!.campaign_id;
    byCamp.set(c, [...(byCamp.get(c) ?? []), id]);
  }
  const camps = new Map(campaigns(db).map((c) => [c.id, c]));
  const perCampaign = [...byCamp].map(([cid, ids]) => ({ campaign: camps.get(cid)!, agg: sumTeams(cur.byTeam, ids) }));
  const a = sumTeams(cur.byTeam, teamIds);
  const p = prev ? sumTeams(prev.byTeam, teamIds) : null;
  const out: Partial<Record<KpiCode, KpiValue>> = {};
  for (const def of KPIS) {
    if (def.finance && !showFinance) continue;
    const { target, amber } = nodeTarget(def, perCampaign, targets);
    const value = def.value(a);
    const pv = p ? def.value(p) : null;
    const dp = def.unit === "€" ? 2 : 1;
    out[def.code] = {
      value: round(value, dp), target: round(target, dp)!, amber: round(amber, dp)!, rag: rag(def, value, target, amber),
      prev: round(pv, dp), delta: value != null && pv != null ? round(value - pv, dp) : null,
    };
  }
  return { agg: a, kpis: out as Record<KpiCode, KpiValue> };
}

// ── scorecard over the hierarchy ───────────────────────────────────────────

export interface ScoreNode {
  id: string; level: Role | "TEAM"; name: string; label: string; owner_id: string | null;
  team_ids: string[]; volume: number; kpis: Record<KpiCode, KpiValue>; children: ScoreNode[];
}

export interface Period { from: string; to: string }

/** Default period: the last `days` closed days (today is still running). */
export function lastDays(now: Date, days: number): Period {
  const to = dayOf(now);
  return { from: dayOf(addDays(new Date(to), -days)), to };
}
export function previousOf(p: Period): Period {
  const len = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000);
  return { from: dayOf(addDays(new Date(p.from), -len)), to: p.from };
}

export const canSeeFinance = (u: User) => u.role === "CSDM" || u.role === "COO";

/**
 * The KPI scorecard as a tree, starting at the viewer:
 * COO → one node per CSDM (their account) → Floor Managers → Team Leaders' teams.
 */
export function scorecard(d: Deps, u: User, period: Period): ScoreNode {
  const cur = loadPeriod(d.db, period.from, period.to);
  const pp = previousOf(period);
  const prev = loadPeriod(d.db, pp.from, pp.to);
  const targets = loadTargets(d.db);
  const finance = canSeeFinance(u);
  const camp = new Map(campaigns(d.db).map((c) => [c.id, c]));
  const cl = new Map(clients(d.db).map((c) => [c.id, c.name]));
  const visible = visibleTeamIds(d.db, u);
  const tt = teams(d.db);

  const label = (n: OrgNode, ids: string[]) => {
    const cs = [...new Set(ids.map((id) => tt.find((t) => t.id === id)!.campaign_id))];
    if (n.user.role === "COO") return "All accounts";
    if (n.user.role === "CSDM") return `${[...new Set(cs.map((c) => cl.get(camp.get(c)!.client_id)))].join(" + ")} account`;
    if (n.user.role === "FM") return cs.map((c) => camp.get(c)!.name).join(" + ");
    return n.teams.map((t) => t.name).join(" + ");
  };

  const build = (n: OrgNode): ScoreNode | null => {
    const ids = teamsUnder(n).filter((id) => visible.has(id));
    if (!ids.length) return null;
    const e = evaluate(ids, cur, prev, d.db, targets, finance);
    const children = n.children.map(build).filter((x): x is ScoreNode => x !== null);
    // a TL leading several teams gets one row per team under them
    if (n.user.role === "TL" && n.teams.length > 1)
      for (const t of n.teams) {
        const te = evaluate([t.id], cur, prev, d.db, targets, finance);
        children.push({ id: t.id, level: "TEAM", name: t.name, label: camp.get(t.campaign_id)!.name, owner_id: n.user.id, team_ids: [t.id], volume: te.agg.offered, kpis: te.kpis, children: [] });
      }
    return { id: n.user.id, level: n.user.role, name: n.user.name, label: label(n, ids), owner_id: n.user.id, team_ids: ids, volume: e.agg.offered, kpis: e.kpis, children };
  };
  return build(orgTree(d.db, u.id))!;
}

export function flatten(n: ScoreNode): ScoreNode[] {
  return [n, ...n.children.flatMap(flatten)];
}

export type Grain = "day" | "week" | "month";
const bucket = (date: string, g: Grain) => {
  if (g === "day") return date;
  if (g === "month") return date.slice(0, 7);
  const d = new Date(date + "T00:00:00Z");
  const monday = addDays(d, -((d.getUTCDay() + 6) % 7));
  return dayOf(monday);
};

/** A KPI over time for a set of teams, with its (weighted) target per point. */
export function trend(d: Deps, teamIds: string[], kpi: KpiCode, period: Period, grain: Grain = "day") {
  const data = loadDaily(d.db, period.from, period.to);
  const targets = loadTargets(d.db);
  const def = KPI[kpi];
  const camps = new Map(campaigns(d.db).map((c) => [c.id, c]));
  const tt = new Map(teams(d.db).map((t) => [t.id, t]));
  const buckets = new Map<string, Map<string, Agg>>(); // bucket → campaign → agg
  for (const id of teamIds) {
    for (const [date, a] of data.get(id) ?? []) {
      const b = bucket(date, grain);
      const cid = tt.get(id)!.campaign_id;
      if (!buckets.has(b)) buckets.set(b, new Map());
      const m = buckets.get(b)!;
      m.set(cid, addInto(m.get(cid) ?? zero(), a));
    }
  }
  return [...buckets.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([b, m]) => {
    const per = [...m].map(([cid, agg]) => ({ campaign: camps.get(cid)!, agg }));
    const total = per.reduce((s, x) => addInto(s, x.agg), zero());
    const { target, amber } = nodeTarget(def, per, targets);
    const value = def.value(total);
    return { period: b, value: round(value, def.unit === "€" ? 2 : 1), target: round(target, 1)!, rag: rag(def, value, target, amber) };
  });
}
