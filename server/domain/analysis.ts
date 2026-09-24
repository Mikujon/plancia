import { all, get } from "../db.ts";
import { createIssue, type Deps } from "./issues.ts";
import {
  flatten, KPI, loadDaily, loadTargets, rag, scorecard, severityOf, trend,
  type Agg, type KpiCode, type Period, type ScoreNode,
} from "./kpi.ts";
import { campaigns, teams } from "./org.ts";
import { addDays, dayOf } from "./time.ts";
import type { Category, User } from "./types.ts";

// ── why did service level miss? ───────────────────────────────────────────

export interface Driver { code: "volume" | "staffing" | "aht" | "adherence" | "absenteeism"; label: string; value: number; unit: string; adverse: boolean; text: string }

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The usual causes of a service-level miss in a contact centre, each measured against its own norm:
 * more contacts than forecast, fewer staff than required, longer handling, agents off schedule, absence.
 * A driver is "adverse" when it's beyond its norm; adverse drivers are listed worst first.
 */
export function slDrivers(a: Agg, ahtTarget: number): Driver[] {
  const list: Driver[] = [];
  if (a.forecast > 0) {
    const v = ((a.offered - a.forecast) / a.forecast) * 100;
    list.push({ code: "volume", label: "Volume vs forecast", value: r1(v), unit: "%", adverse: v > 5, text: `volume ${v >= 0 ? "+" : ""}${r1(v)}% vs forecast` });
  }
  if (a.required_hours > 0) {
    const v = ((a.logged_hours - a.required_hours) / a.required_hours) * 100;
    list.push({ code: "staffing", label: "Staffing vs requirement", value: r1(v), unit: "%", adverse: v < -5, text: `staffing ${v >= 0 ? "+" : ""}${r1(v)}% vs required` });
  }
  if (a.answered > 0) {
    const aht = (a.handle_hours * 3600) / a.answered;
    const v = ((aht - ahtTarget) / ahtTarget) * 100;
    list.push({ code: "aht", label: "AHT vs target", value: r1(v), unit: "%", adverse: v > 5, text: `AHT ${Math.round(aht)}s (${v >= 0 ? "+" : ""}${r1(v)}% vs ${ahtTarget}s)` });
  }
  if (a.logged_hours > 0) {
    const v = (a.adherent_hours / a.logged_hours) * 100;
    list.push({ code: "adherence", label: "Schedule adherence", value: r1(v), unit: "%", adverse: v < 90, text: `adherence ${r1(v)}%` });
  }
  if (a.paid_hours > 0) {
    const v = (a.absent_hours / a.paid_hours) * 100;
    list.push({ code: "absenteeism", label: "Absenteeism", value: r1(v), unit: "%", adverse: v > 8, text: `absenteeism ${r1(v)}%` });
  }
  const weight = (x: Driver) => (x.code === "adherence" ? 90 - x.value : x.code === "staffing" ? -x.value : x.code === "absenteeism" ? x.value - 8 : x.value);
  return list.sort((x, y) => Number(y.adverse) - Number(x.adverse) || weight(y) - weight(x));
}

const SERVICE: KpiCode[] = ["sl", "asa", "abandon"];
/** Drivers are inputs, not outcomes: they explain exceptions but aren't exceptions themselves. */
const NOT_EXCEPTIONS: KpiCode[] = ["forecast_var", "coverage"];

export interface Exception {
  node_id: string; node_name: string; label: string; level: string; team_ids: string[];
  kpi: KpiCode; kpi_name: string; unit: string; value: number; target: number; severity: number;
  drivers: Driver[]; spark: (number | null)[];
  open_action: { id: string; ref: string; due_at: string; owner_name: string } | null;
}

/** Every KPI in red at the operational level (teams) — and finance at account level — ranked by how far off it is. */
export function exceptions(d: Deps, u: User, period: Period): Exception[] {
  const tree = scorecard(d, u, period);
  const nodes = flatten(tree);
  const leaves = nodes.filter((n) => n.children.length === 0);
  const accounts = nodes.filter((n) => n.level === "CSDM");
  const tt = new Map(teams(d.db).map((t) => [t.id, t]));
  const targets = loadTargets(d.db);
  const data = loadDaily(d.db, period.from, period.to);
  const out: Exception[] = [];

  const push = (n: ScoreNode, code: KpiCode) => {
    const k = n.kpis[code];
    if (!k || k.rag !== "red" || k.value == null) return;
    const def = KPI[code];
    let drivers: Driver[] = [];
    if (SERVICE.includes(code)) {
      drivers = slDrivers(sumPeriod(data, n.team_ids), n.kpis.aht?.target ?? targetFor(targets, tt.get(n.team_ids[0])!.campaign_id, "aht"));
    }
    const action = get<{ id: string; ref: string; due_at: string; owner_name: string }>(d.db, `
      SELECT i.id, i.ref, i.due_at, u.name AS owner_name FROM issues i JOIN users u ON u.id = i.owner_id
      WHERE i.kpi = ? AND i.status IN ('open','in_progress') AND i.team_id IN (${n.team_ids.map(() => "?").join(",")})
      ORDER BY i.due_at LIMIT 1`, code, ...n.team_ids) ?? null;
    out.push({
      node_id: n.id, node_name: n.name, label: n.label, level: n.level, team_ids: n.team_ids,
      kpi: code, kpi_name: def.name, unit: def.unit, value: k.value, target: k.target,
      severity: Math.round(severityOf(def, k.value, k.target, k.amber) * 10) / 10,
      drivers: drivers.filter((x) => x.adverse),
      spark: trend(d, n.team_ids, code, { from: dayOf(addDays(new Date(period.to), -7)), to: period.to }).map((p) => p.value),
      open_action: action,
    });
  };

  for (const n of leaves) for (const def of Object.values(KPI)) if (!def.finance && !NOT_EXCEPTIONS.includes(def.code)) push(n, def.code);
  for (const n of accounts) for (const def of Object.values(KPI)) if (def.finance) push(n, def.code);
  return out.sort((a, b) => b.severity - a.severity);
}

function sumPeriod(data: Map<string, Map<string, Agg>>, teamIds: string[]): Agg {
  const acc = {} as Agg;
  for (const id of teamIds)
    for (const x of data.get(id)?.values() ?? [])
      for (const [k, v] of Object.entries(x) as [keyof Agg, number][]) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}

function targetFor(targets: ReturnType<typeof loadTargets>, campaignId: string, code: KpiCode) {
  return targets.get(`${campaignId}|${code}`)?.target ?? KPI[code].target;
}

// ── what moved ────────────────────────────────────────────────────────────

export interface Mover { node_id: string; node_name: string; label: string; level: string; kpi: KpiCode; kpi_name: string; unit: string; value: number; prev: number; delta: number; better: boolean; score: number }

/** Biggest changes vs the previous period of the same length, in "amber bands" so KPIs compare fairly. */
export function movers(d: Deps, u: User, period: Period, limit = 6) {
  const nodes = flatten(scorecard(d, u, period)).filter((n) => n.level !== u.role);
  const all: Mover[] = [];
  for (const n of nodes)
    for (const [code, k] of Object.entries(n.kpis) as [KpiCode, (typeof n.kpis)[KpiCode]][]) {
      if (k.value == null || k.prev == null || k.delta == null || NOT_EXCEPTIONS.includes(code)) continue;
      const def = KPI[code];
      const improving = def.better === "higher" ? k.delta > 0 : def.better === "lower" ? k.delta < 0
        : Math.abs(k.value - k.target) < Math.abs(k.prev - k.target);
      all.push({
        node_id: n.id, node_name: n.name, label: n.label, level: n.level, kpi: code, kpi_name: def.name, unit: def.unit,
        value: k.value, prev: k.prev, delta: k.delta, better: improving, score: Math.round((Math.abs(k.delta) / (k.amber || 1)) * 10) / 10,
      });
    }
  const ranked = all.filter((m) => m.score >= 0.5).sort((a, b) => b.score - a.score);
  return { improving: ranked.filter((m) => m.better).slice(0, limit), declining: ranked.filter((m) => !m.better).slice(0, limit) };
}

// ── league table ──────────────────────────────────────────────────────────

/**
 * Teams (or managers) ranked on one KPI, best first, with quartile.
 * Ranked on variance to each node's own target, not the raw value: a 540s AHT on Disputes and a 300s AHT
 * on Courier aren't comparable, but "+4% over target" and "−2% under target" are.
 */
export function league(d: Deps, u: User, period: Period, kpi: KpiCode, level: "team" | "FM" = "team") {
  const def = KPI[kpi];
  const nodes = flatten(scorecard(d, u, period)).filter((n) => (level === "team" ? n.children.length === 0 && (n.level === "TL" || n.level === "TEAM") : n.level === "FM"));
  const variance = (v: number, t: number, amber: number) =>
    def.better === "band" ? -Math.abs(v - t) / (amber || 1)
      : (def.better === "higher" ? v - t : t - v) / (Math.abs(t) || 1) * 100;
  const rows = nodes
    .filter((n) => n.kpis[kpi]?.value != null)
    .map((n) => {
      const k = n.kpis[kpi];
      return { node_id: n.id, name: n.name, label: n.label, value: k.value!, target: k.target, rag: k.rag, volume: n.volume,
        vs_target: Math.round(variance(k.value!, k.target, k.amber) * 10) / 10 };
    })
    .sort((a, b) => b.vs_target - a.vs_target);
  return rows.map((r, i) => ({ ...r, rank: i + 1, quartile: Math.min(4, Math.floor((i / rows.length) * 4) + 1) }));
}

// ── KPI breaches become owned actions ─────────────────────────────────────

/** KPIs that open an action on their own after a run of red days. */
export const WATCHED: KpiCode[] = ["sl", "aht", "adherence", "absenteeism", "qa", "csat"];
export const RED_DAYS = 3;

const CATEGORY: Partial<Record<KpiCode, Category>> = { sl: "sla", aht: "quality", adherence: "staffing", absenteeism: "staffing", qa: "quality", csat: "quality" };

/**
 * Performance management: a watched KPI red for RED_DAYS closed days in a row opens an action for the
 * team's TL, with the numbers and the drivers, unless one is already open for that team and KPI.
 * From there the normal pick-up and due-date clocks apply.
 */
export function raiseKpiActions(d: Deps): string[] {
  const now = d.clock();
  const to = dayOf(now);
  const from = dayOf(addDays(new Date(to), -RED_DAYS));
  const data = loadDaily(d.db, from, to);
  const targets = loadTargets(d.db);
  const camp = new Map(campaigns(d.db).map((c) => [c.id, c]));
  const opened: string[] = [];
  for (const t of teams(d.db)) {
    const days = [...(data.get(t.id)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
    if (days.length < RED_DAYS) continue;
    for (const code of WATCHED) {
      const def = KPI[code];
      const tg = targets.get(`${t.campaign_id}|${code}`) ?? { target: def.target, amber: def.amber };
      const values = days.map(([, a]) => def.value(a));
      if (!values.every((v) => rag(def, v, tg.target, tg.amber) === "red")) continue;
      const exists = get(d.db, "SELECT 1 FROM issues WHERE team_id = ? AND kpi = ? AND status IN ('open','in_progress')", t.id, code);
      const ref = `${t.id}:${code}:${to}`;
      if (exists || get(d.db, "SELECT 1 FROM issues WHERE source = 'kpi' AND source_ref = ?", ref)) continue;
      const fmt = (v: number | null) => (v == null ? "—" : def.unit === "s" ? `${Math.round(v)}s` : `${Math.round(v * 10) / 10}${def.unit}`);
      const drivers = code === "sl" ? slDrivers(sumPeriod(data, [t.id]), targetFor(targets, t.campaign_id, "aht")).filter((x) => x.adverse) : [];
      const i = createIssue(d, null, {
        team_id: t.id,
        title: `${def.name} off target ${RED_DAYS} days running: ${fmt(values.at(-1)!)} vs ${fmt(tg.target)}`,
        description: [
          `${camp.get(t.campaign_id)!.name} · ${t.name}`,
          `Daily ${def.name}: ${days.map(([date], k) => `${date.slice(5)} ${fmt(values[k])}`).join(", ")} (target ${fmt(tg.target)}).`,
          drivers.length ? `Likely drivers: ${drivers.map((x) => x.text).join("; ")}.` : "",
          "Agree the cause and the corrective action with the team; close this with what changed.",
        ].filter(Boolean).join("\n"),
        category: CATEGORY[code] ?? "other",
        severity: code === "sl" ? "high" : "medium",
        sla_related: code === "sl",
        source: "kpi",
        source_ref: ref,
        kpi: code,
        layer: "TL",
      });
      opened.push(i.id);
    }
  }
  return opened;
}

/** Actions linked to KPIs, by KPI: how many opened, closed on time, still open. */
export function actionsByKpi(d: Deps, teamIds: string[], period: Period) {
  if (!teamIds.length) return [];
  return all<{ kpi: string; opened: number; closed: number; on_time: number; open_now: number }>(d.db, `
    SELECT kpi, COUNT(*) AS opened, SUM(resolved_at IS NOT NULL) AS closed, SUM(resolved_at <= due_at) AS on_time,
      SUM(status IN ('open','in_progress')) AS open_now
    FROM issues WHERE kpi IS NOT NULL AND team_id IN (${teamIds.map(() => "?").join(",")}) AND created_at >= ? AND created_at < ?
    GROUP BY kpi ORDER BY opened DESC`, ...teamIds, period.from, period.to + "T99");
}
