import { all, get, run, type DB } from "../db.ts";
import type { WfmPort } from "../ports/wfm.ts";
import { gapCost } from "./cost.ts";
import { createIssue, type Deps } from "./issues.ts";
import { assertTeamVisible, campaigns, floors, teams, users, visibleTeamIds } from "./org.ts";
import { iso, minutesBetween, shiftWindow } from "./time.ts";
import type { Shift, User } from "./types.ts";

export interface StaffingRow {
  team_id: string; team_name: string; floor_id: string; floor_name: string; tl_name: string;
  campaign_id: string; campaign_name: string; client_id: string;
  shift_id: string; shift_name: string; date: string; hours_left: number;
  required: number; scheduled: number; present: number; gap: number; gap_pct: number;
  gap_cost: number; at_risk: boolean; source: "rta" | "manual"; observed_at: string;
}

/** A gap at or above this share of the requirement puts the SLA at risk. */
export const RISK_GAP_PCT = 10;
/** A gap this large (share and heads) opens a tracked staffing issue on its own. */
export const AUTO_ISSUE_GAP_PCT = 15;
export const AUTO_ISSUE_MIN_HEADS = 2;
const MANUAL_OVERRIDE_MIN = 30;

export const shifts = (db: DB) => all<Shift>(db, "SELECT * FROM shifts ORDER BY start_hhmm");

export function requiredFor(db: DB) {
  const plan = new Map(
    all<{ team_id: string; shift_id: string; required: number }>(db, "SELECT * FROM team_shift_plan")
      .map((r) => [`${r.team_id}|${r.shift_id}`, r.required]),
  );
  return (teamId: string, shiftId: string) => plan.get(`${teamId}|${shiftId}`) ?? 0;
}

/** Live staffing for every active shift, one row per team, with the cost of each gap. */
export async function liveStaffing(d: Deps, wfm: WfmPort, u: User | null, f: { campaign_id?: string } = {}): Promise<StaffingRow[]> {
  const { db } = d;
  const now = d.clock();
  const visible = u ? visibleTeamIds(db, u) : null;
  const plan = requiredFor(db);
  const allTeams = teams(db).filter((t) => (!visible || visible.has(t.id)) && (!f.campaign_id || t.campaign_id === f.campaign_id));
  const camp = new Map(campaigns(db).map((c) => [c.id, c]));
  const fl = new Map(floors(db).map((x) => [x.id, x]));
  const names = new Map(users(db).map((x) => [x.id, x.name]));
  const out: StaffingRow[] = [];

  for (const s of shifts(db)) {
    const w = shiftWindow(s, now);
    if (!w.active) continue;
    const staffed = allTeams.filter((t) => plan(t.id, s.id) > 0);
    if (!staffed.length) continue;
    const readings = await wfm.liveStaffing({ date: w.date, shift_id: s.id, team_ids: staffed.map((t) => t.id) });
    for (const r of readings) {
      const t = staffed.find((x) => x.id === r.team_id);
      if (!t) continue;
      const c = camp.get(t.campaign_id)!;
      const manual = get<{ scheduled: number; present: number; observed_at: string }>(db,
        `SELECT scheduled, present, observed_at FROM staffing_snapshots
         WHERE team_id = ? AND shift_id = ? AND date = ? AND source = 'manual' ORDER BY observed_at DESC LIMIT 1`,
        t.id, s.id, w.date);
      const useManual = manual && minutesBetween(manual.observed_at, now) <= MANUAL_OVERRIDE_MIN;
      const scheduled = useManual ? manual.scheduled : r.scheduled;
      const present = useManual ? manual.present : r.present;
      const gap = Math.max(0, r.required - present);
      const gap_pct = r.required ? Math.round((gap / r.required) * 100) : 0;
      out.push({
        team_id: t.id, team_name: t.name, floor_id: t.floor_id, floor_name: fl.get(t.floor_id)?.name ?? "",
        tl_name: names.get(t.tl_id) ?? "", campaign_id: c.id, campaign_name: c.name, client_id: c.client_id,
        shift_id: s.id, shift_name: s.name, date: w.date, hours_left: Math.round(w.hoursLeft * 10) / 10,
        required: r.required, scheduled, present, gap, gap_pct,
        gap_cost: gapCost(c, gap, w.hoursLeft), at_risk: gap_pct >= RISK_GAP_PCT,
        source: useManual ? "manual" : "rta", observed_at: useManual ? manual.observed_at : r.observed_at,
      });
      if (!useManual) snapshot(db, t.id, s.id, w.date, r.required, scheduled, present, "rta", r.observed_at);
    }
  }
  return out;
}

function snapshot(db: DB, teamId: string, shiftId: string, date: string, required: number, scheduled: number,
  present: number, source: string, observedAt: string) {
  const last = get<{ present: number; scheduled: number; observed_at: string }>(db,
    `SELECT present, scheduled, observed_at FROM staffing_snapshots
     WHERE team_id = ? AND shift_id = ? AND date = ? AND source = ? ORDER BY id DESC LIMIT 1`,
    teamId, shiftId, date, source);
  if (last && last.observed_at === observedAt) return;
  if (last && last.present === present && last.scheduled === scheduled && minutesBetween(last.observed_at, observedAt) < 30) return;
  run(db, `INSERT INTO staffing_snapshots (team_id, shift_id, date, required, scheduled, present, source, observed_at)
    VALUES (?,?,?,?,?,?,?,?)`, teamId, shiftId, date, required, scheduled, present, source, observedAt);
}

/** A TL corrects the feed by hand; it wins over RTA for 30 minutes. */
export function manualStaffing(d: Deps, u: User, p: { team_id: string; shift_id: string; date: string; scheduled: number; present: number }) {
  assertTeamVisible(d.db, u, p.team_id);
  const required = requiredFor(d.db)(p.team_id, p.shift_id);
  run(d.db, `INSERT INTO staffing_snapshots (team_id, shift_id, date, required, scheduled, present, source, observed_at)
    VALUES (?,?,?,?,?,?,'manual',?)`, p.team_id, p.shift_id, p.date, required, p.scheduled, p.present, iso(d.clock()));
  d.bus.emit({ entity: "staffing", id: p.team_id });
}

/** Opens a tracked staffing issue for any gap big enough, once per team and shift. */
export async function raiseGapIssues(d: Deps, wfm: WfmPort): Promise<string[]> {
  const rows = await liveStaffing(d, wfm, null);
  const opened: string[] = [];
  for (const r of rows) {
    if (r.gap < AUTO_ISSUE_MIN_HEADS || r.gap_pct < AUTO_ISSUE_GAP_PCT) continue;
    const ref = `${r.date}:${r.shift_id}:${r.team_id}`;
    const exists = get(d.db, "SELECT 1 FROM issues WHERE source = 'rta' AND source_ref = ?", ref);
    if (exists) continue;
    const i = createIssue(d, null, {
      team_id: r.team_id,
      title: `Understaffed: ${r.present}/${r.required} on ${r.shift_name} (${r.team_name})`,
      description: `RTA shows ${r.gap} agents short (${r.gap_pct}%) with ${r.hours_left}h left in the shift. Revenue at risk if the gap holds: €${r.gap_cost.toFixed(0)}.`,
      category: "staffing",
      severity: r.gap_pct >= 25 ? "high" : "medium",
      sla_related: r.gap_pct >= 25,
      impact_type: "understaffing",
      impact_hours: Math.round(r.gap * r.hours_left * 10) / 10,
      source: "rta",
      source_ref: ref,
    });
    opened.push(i.id);
  }
  return opened;
}
