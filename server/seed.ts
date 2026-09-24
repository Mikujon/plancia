import { randomUUID } from "node:crypto";
import { run, tx, type DB } from "./db.ts";
import { impactAmount } from "./domain/cost.ts";
import { DEFAULT_POLICY } from "./domain/escalation.ts";
import { addDays, addMinutes, dayOf, iso } from "./domain/time.ts";
import type { Campaign, Category, ImpactType, Role, Severity } from "./domain/types.ts";

/** Small deterministic PRNG so every fresh database looks the same. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    between: (lo: number, hi: number) => lo + next() * (hi - lo),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}

// Reporting line: COO → CSDM (one per client) → Floor Manager → Team Leader.
const USERS: [string, string, Role, string | null][] = [
  ["u-coo", "Arben Kola", "COO", null],
  ["u-csdm-kl", "Giulia Ferri", "CSDM", "u-coo"],
  ["u-csdm-je", "Tom Whitaker", "CSDM", "u-coo"],
  ["u-fm-a", "Elira Dervishi", "FM", "u-csdm-kl"],
  ["u-fm-b", "Marco Bellini", "FM", "u-csdm-kl"],
  ["u-fm-c", "Sara Leka", "FM", "u-csdm-je"],
  ["u-fm-d", "Paolo Rinaldi", "FM", "u-csdm-je"],
  ["u-tl-1", "Denis Hoxha", "TL", "u-fm-a"],
  ["u-tl-2", "Anna Russo", "TL", "u-fm-a"],
  ["u-tl-3", "Klevis Brahimi", "TL", "u-fm-b"],
  ["u-tl-4", "Laura Conti", "TL", "u-fm-b"],
  ["u-tl-5", "Ergys Shehu", "TL", "u-fm-c"],
  ["u-tl-6", "Martina Greco", "TL", "u-fm-c"],
  ["u-tl-7", "Besa Meta", "TL", "u-fm-d"],
  ["u-tl-8", "Luca Marino", "TL", "u-fm-d"],
];

const CAMPAIGNS: Omit<Campaign, "csdm_id">[] = [
  { id: "c-kl-cs", client_id: "cl-klarna", name: "Klarna · Customer Service EN", code: "KCS", hourly_cost: 9.8, billing_rate: 19.5, overtime_multiplier: 1.3, sla_target_pct: 80, sl_threshold_sec: 20, sla_penalty_per_day: 1800 },
  { id: "c-kl-dsp", client_id: "cl-klarna", name: "Klarna · Disputes", code: "KDS", hourly_cost: 10.6, billing_rate: 22, overtime_multiplier: 1.3, sla_target_pct: 85, sl_threshold_sec: 60, sla_penalty_per_day: 1200 },
  { id: "c-je-cour", client_id: "cl-justeat", name: "Just Eat · Courier Support", code: "JEC", hourly_cost: 8.6, billing_rate: 16.8, overtime_multiplier: 1.25, sla_target_pct: 80, sl_threshold_sec: 20, sla_penalty_per_day: 1500 },
  { id: "c-je-care", client_id: "cl-justeat", name: "Just Eat · Customer Care IT", code: "JEI", hourly_cost: 9.2, billing_rate: 17.8, overtime_multiplier: 1.25, sla_target_pct: 75, sl_threshold_sec: 30, sla_penalty_per_day: 900 },
];

// Contract / internal targets that differ from the defaults in kpi.ts: [kpi, target, amber]
const TARGETS: Record<string, [string, number, number][]> = {
  "c-kl-cs": [["aht", 420, 20], ["asa", 20, 10], ["abandon", 5, 2], ["csat", 86, 3], ["cost_per_contact", 1.95, 0.15], ["margin", 25, 3]],
  "c-kl-dsp": [["aht", 540, 30], ["asa", 45, 15], ["abandon", 8, 3], ["csat", 80, 4], ["cost_per_contact", 2.7, 0.2], ["margin", 32, 3]],
  "c-je-cour": [["aht", 300, 15], ["asa", 20, 10], ["abandon", 5, 2], ["csat", 84, 3], ["cost_per_contact", 1.25, 0.1], ["margin", 23, 3]],
  "c-je-care": [["aht", 360, 20], ["asa", 30, 10], ["abandon", 6, 2], ["csat", 85, 3], ["cost_per_contact", 1.6, 0.12], ["margin", 28, 3]],
};

// team id, name, floor, campaign, TL
const TEAMS: [string, string, string, string, string][] = [
  ["t-kcs-1", "KCS Alpha", "f-a", "c-kl-cs", "u-tl-1"],
  ["t-kcs-2", "KCS Bravo", "f-a", "c-kl-cs", "u-tl-2"],
  ["t-kds-1", "Disputes Core", "f-b", "c-kl-dsp", "u-tl-3"],
  ["t-kds-2", "Disputes Chargeback", "f-b", "c-kl-dsp", "u-tl-4"],
  ["t-jec-1", "Courier Day", "f-c", "c-je-cour", "u-tl-5"],
  ["t-jec-2", "Courier Late", "f-c", "c-je-cour", "u-tl-6"],
  ["t-jei-1", "Care IT Milano", "f-d", "c-je-care", "u-tl-7"],
  ["t-jei-2", "Care IT Roma", "f-d", "c-je-care", "u-tl-8"],
];

const SHIFTS = [
  ["s-morning", "Morning", "06:00", "14:00"],
  ["s-afternoon", "Afternoon", "14:00", "22:00"],
  ["s-night", "Night", "22:00", "06:00"],
] as const;

// Issue templates: category, severity, title, impact type, hours range, resolution
const TEMPLATES: [Category, Severity, string, ImpactType, [number, number], string][] = [
  ["staffing", "high", "Six no-shows on the morning shift", "understaffing", [8, 30], "Moved 3 agents from the other team, called in 2 on overtime."],
  ["staffing", "medium", "Sick leave wave — two agents out", "overtime", [4, 12], "Covered with overtime from the afternoon shift."],
  ["staffing", "medium", "Late logins after break, adherence below 85%", "understaffing", [2, 8], "Break schedule staggered; adherence back to 93%."],
  ["system", "critical", "CTI down — agents cannot take contacts", "understaffing", [20, 60], "Vendor restarted the CTI node; post-mortem requested."],
  ["system", "high", "CRM slow, handle time up 40%", "overtime", [6, 18], "Client IT cleared the cache cluster; AHT normal."],
  ["system", "medium", "VPN drops for home-working agents", "understaffing", [3, 10], "Switched the pool to the backup gateway."],
  ["sla", "critical", "Queue over 300 — service level breaching", "sla_penalty", [0, 0], "Opened overflow to the second team, SL recovered by 16:00."],
  ["sla", "high", "Chat wait time above 4 min", "sla_penalty", [0, 0], "Added 4 agents from email to chat for two hours."],
  ["client", "high", "Client flagged wrong refund script", "other", [0, 0], "Script corrected with the client; 40 cases re-contacted."],
  ["client", "medium", "Client asks for extra reporting on disputes", "none", [0, 0], "Daily report added to the CSDM pack."],
  ["quality", "medium", "QA score dropped under 80% on two agents", "none", [0, 0], "Coaching plan agreed, re-audit in 2 weeks."],
  ["quality", "low", "Outdated macro used in replies", "none", [0, 0], "Macro library updated."],
  ["hr", "medium", "Conflict between two agents on the floor", "none", [0, 0], "Handled with HR, seating changed."],
  ["other", "low", "Headsets missing for new starters", "other", [0, 0], "IT delivered 12 headsets."],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function seed(db: DB, now: Date = new Date()) {
  const r = prng(20260924);
  const today = dayOf(now);
  const P = DEFAULT_POLICY;

  tx(db, () => {
    for (const [id, name, role, manager] of USERS)
      run(db, "INSERT INTO users (id, name, role, email, manager_id) VALUES (?,?,?,?,?)", id, name, role,
        `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, manager);
    run(db, "INSERT INTO clients VALUES (?,?,?)", "cl-klarna", "Klarna", "#E3739B");
    run(db, "INSERT INTO clients VALUES (?,?,?)", "cl-justeat", "Just Eat", "#E8792B");
    for (const c of CAMPAIGNS)
      run(db, `INSERT INTO campaigns (id, client_id, name, code, hourly_cost, billing_rate, overtime_multiplier, sla_target_pct,
        sl_threshold_sec, sla_penalty_per_day, csdm_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, c.id, c.client_id, c.name, c.code, c.hourly_cost,
        c.billing_rate, c.overtime_multiplier, c.sla_target_pct, c.sl_threshold_sec, c.sla_penalty_per_day,
        c.client_id === "cl-klarna" ? "u-csdm-kl" : "u-csdm-je");
    for (const [cid, list] of Object.entries(TARGETS))
      for (const [kpi, target, amber] of list) run(db, "INSERT INTO kpi_targets VALUES (?,?,?,?)", cid, kpi, target, amber);
    run(db, "INSERT INTO floors VALUES (?,?,?)", "f-a", "Floor A", "Tirana");
    run(db, "INSERT INTO floors VALUES (?,?,?)", "f-b", "Floor B", "Tirana");
    run(db, "INSERT INTO floors VALUES (?,?,?)", "f-c", "Floor C", "Durrës");
    run(db, "INSERT INTO floors VALUES (?,?,?)", "f-d", "Floor D", "Durrës");
    for (const t of TEAMS) run(db, "INSERT INTO teams VALUES (?,?,?,?,?)", ...t);
    for (const s of SHIFTS) run(db, "INSERT INTO shifts VALUES (?,?,?,?)", ...s);

    // Shift plan: every team staffs morning + afternoon; Klarna CS and Courier Late also cover nights.
    const heads = new Map<string, number>();
    for (const [tid, , , cid] of TEAMS) {
      const base = cid === "c-kl-cs" ? 22 : cid === "c-je-cour" ? 18 : 12;
      const m = base + r.int(-2, 3), a = base + r.int(-3, 2);
      run(db, "INSERT INTO team_shift_plan VALUES (?,?,?)", tid, "s-morning", m);
      run(db, "INSERT INTO team_shift_plan VALUES (?,?,?)", tid, "s-afternoon", a);
      let n = m + a;
      if (tid === "t-kcs-1" || tid === "t-jec-2") { const x = Math.round(base / 3); n += x; run(db, "INSERT INTO team_shift_plan VALUES (?,?,?)", tid, "s-night", x); }
      heads.set(tid, n);
    }

    // ── 60 closed days of KPI raw data per team ──
    // The model is the usual contact-centre coupling: capacity (logged-in hours) against workload
    // (volume × AHT) drives service level, abandon and wait. Four patterns are planted for the analysis:
    //   Courier Day      — Monday absenteeism → staffing short → SL misses on Mondays
    //   KCS Bravo        — AHT creeping up over the last three weeks → SL red in the last ~10 days
    //   Care IT Roma     — QA score dip in the last 12 days
    //   Disputes Chargeback — month-start volume above forecast
    const camp = new Map(CAMPAIGNS.map((c) => [c.id, c]));
    const target = (cid: string, kpi: string, fallback: number) => TARGETS[cid]?.find(([k]) => k === kpi)?.[1] ?? fallback;
    for (let back = 60; back >= 1; back--) {
      const date = dayOf(addDays(now, -back));
      const dt = new Date(date + "T00:00:00Z");
      const dow = dt.getUTCDay();
      for (const [tid, , , cid] of TEAMS) {
        const c = camp.get(cid)!;
        const ahtT = target(cid, "aht", 360);
        const weekend = dow === 0 || dow === 6 ? (cid === "c-je-cour" ? 1 : 0.7) : 1;
        const paid = heads.get(tid)! * 7.5 * weekend * r.between(0.98, 1.02);
        let absRate = r.between(0.03, 0.055);
        if (tid === "t-jec-1" && dow === 1) absRate += 0.08;
        if (tid === "t-jec-2") absRate += 0.01;
        const absent = paid * absRate;
        const planned = r.between(0.21, 0.24); // breaks, training, coaching
        const logged = (paid - absent) * (1 - planned);
        let drift = 1;
        if (tid === "t-kcs-2" && back <= 21) drift = 1 + 0.13 * ((21 - back) / 21);
        const aht = ahtT * r.between(0.96, 1.03) * drift;
        const loggedPlan = paid * 0.955 * 0.775;
        const forecast = Math.round((loggedPlan * 0.85 * 3600) / ahtT);
        let offered = Math.round(forecast * r.between(0.95, 1.05));
        if (tid === "t-kds-2" && dt.getUTCDate() <= 3) offered = Math.round(offered * 1.22);
        const required = (forecast * ahtT) / 3600 / 0.85;
        const ratio = (logged * 0.85) / ((offered * aht) / 3600); // capacity vs workload at target occupancy
        const sl = clamp(c.sla_target_pct + 3.5 + (ratio - 1) * 140 + r.between(-2, 2), 35, 97);
        const abandonPct = clamp(2.2 + (1 - ratio) * 35 + r.between(-0.5, 0.5), 0.5, 30);
        let answered = Math.round(offered * (1 - abandonPct / 100));
        if ((answered * aht) / 3600 > logged * 0.93) answered = Math.floor((logged * 0.93 * 3600) / aht);
        const abandoned = offered - answered;
        const handle = (answered * aht) / 3600;
        const inSl = Math.min(answered, Math.round((offered * sl) / 100));
        const asaT = target(cid, "asa", 30);
        const asa = clamp(asaT * 0.6 + (1 - ratio) * 160 + r.between(-3, 3), 3, 400);
        const adherence = r.between(0.915, 0.955) - (tid === "t-jec-2" ? 0.02 : 0);
        const overtime = ratio < 0.93 ? r.int(2, 12) : r.chance(0.1) ? 3 : 0;
        const fcrN = Math.round(answered * 0.15);
        const csatN = Math.round(answered * 0.06);
        const csatT = target(cid, "csat", 85) / 100;
        const csatRate = clamp(csatT + r.between(-0.005, 0.04) - Math.max(0, c.sla_target_pct - sl) / 250, 0.5, 0.99);
        const qaN = Math.max(3, Math.round(heads.get(tid)! * 0.25));
        const qa = r.between(88.5, 93) - (tid === "t-jei-2" && back <= 12 ? 7 : 0);
        run(db, `INSERT INTO kpi_daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          date, tid, offered, forecast, answered, inSl, abandoned, +handle.toFixed(2), +((answered * asa) / 3600).toFixed(2),
          +paid.toFixed(2), +logged.toFixed(2), +required.toFixed(2), +(logged * adherence).toFixed(2), +absent.toFixed(2), overtime,
          Math.round(fcrN * r.between(0.73, 0.8)), fcrN, Math.round(csatN * csatRate), csatN, +(qaN * qa).toFixed(1), qaN, "seed");
      }
    }
    // headcount & leavers for the last three months (attrition)
    for (let m = 2; m >= 0; m--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
      const month = d.toISOString().slice(0, 7);
      for (const [tid] of TEAMS) {
        const hc = Math.round(heads.get(tid)! * 1.15);
        const leavers = tid === "t-jec-2" ? r.int(2, 4) : r.chance(0.6) ? r.int(0, 1) : r.int(1, 2);
        run(db, "INSERT INTO headcount_monthly VALUES (?,?,?,?)", month, tid, hc, leavers);
      }
    }

    // ── issues / actions: 60 days of history plus what's open right now ──
    const counters = new Map<string, number>();
    const chain: Record<string, string> = Object.fromEntries(USERS.map(([id, , , m]) => [id, m ?? ""]));
    const role: Record<string, Role> = Object.fromEntries(USERS.map(([id, , r]) => [id, r]));
    const H = 3_600_000;

    const addIssue = (o: {
      team: (typeof TEAMS)[number]; tpl: (typeof TEMPLATES)[number]; created: Date; ups: number;
      resolvedAfterMin: number | null; acked?: boolean; source?: string; kpi?: string; title?: string; dueInMin?: number;
    }) => {
      const [tid, , , cid, tl] = o.team;
      const c = camp.get(cid)!;
      const [category, severity, title, itype, [hlo, hhi], resolution] = o.tpl;
      const n = (counters.get(cid) ?? 0) + 1;
      counters.set(cid, n);
      const id = randomUUID();
      const ref = `${c.code}-${String(n).padStart(4, "0")}`;
      const hours = hhi ? r.int(hlo, hhi) : 0;
      const amount = impactAmount(c, itype, hours, itype === "other" ? r.int(2, 12) * 100 : itype === "sla_penalty" ? r.int(3, 9) * 100 : null);
      const events: [string, string | null, string, string | null, string | null, string | null][] = [];
      let t = o.created;
      let due = new Date(t.getTime() + P.resolveHours[severity] * H);
      events.push([iso(t), tl, "created", null, "TL", o.source ?? "floor"]);
      events.push([iso(t), tl, "assigned", null, tl, null]);
      events.push([iso(t), tl, "due", null, iso(due), "initial due date"]);
      if (amount > 0) events.push([iso(t), tl, "cost", null, String(amount), `${itype} · ${hours}h`]);
      let owner = tl;
      let layerSince = t;
      let ack: Date | null = null;
      const live = o.resolvedAfterMin == null;
      const step = live ? (now.getTime() - o.created.getTime()) / 60000 / (o.ups + 1) : r.int(15, 120);
      for (let k = 0; k < o.ups && chain[owner]; k++) {
        t = addMinutes(t, step);
        const next = chain[owner];
        const auto = r.chance(0.5);
        events.push([iso(t), auto ? null : owner, "escalated", role[owner], role[next], auto ? `Auto: not picked up at ${role[owner]} in time (${severity})` : "Needs a decision above my level"]);
        events.push([iso(t), auto ? null : owner, "assigned", owner, next, null]);
        const fresh = new Date(t.getTime() + Math.max(P.minWindowHours, P.resolveHours[severity] * P.escalatedShare) * H);
        if (fresh > due) { events.push([iso(t), null, "due", iso(due), iso(fresh), `new window at ${role[next]}`]); due = fresh; }
        owner = next; layerSince = t;
      }
      if (o.dueInMin !== undefined) due = addMinutes(now, o.dueInMin);
      let resolvedAt: string | null = null;
      if (!live) {
        ack = addMinutes(layerSince, r.int(2, 25));
        events.push([iso(ack), owner, "status", "open", "in_progress", null]);
        const minAfter = (ack.getTime() - o.created.getTime()) / 60000 + 5;
        resolvedAt = iso(addMinutes(o.created, Math.max(o.resolvedAfterMin!, minAfter)));
        events.push([resolvedAt, owner, "resolved", "in_progress", "resolved", resolution]);
      } else if (o.acked) {
        ack = addMinutes(layerSince, Math.min(4, (now.getTime() - layerSince.getTime()) / 60000));
        events.push([iso(ack), owner, "status", "open", "in_progress", null]);
      }
      const status = resolvedAt ? (r.chance(0.6) ? "closed" : "resolved") : ack ? "in_progress" : "open";
      run(db, `INSERT INTO issues (id, ref, campaign_id, team_id, title, description, category, severity, status, layer, layer_since,
        owner_id, raised_by, source, source_ref, sla_related, impact_type, impact_hours, impact_amount, resolution, kpi, due_at,
        acknowledged_at, created_at, updated_at, resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ref, cid, tid, o.title ?? title, "", category, severity, status, role[owner], iso(layerSince), owner, tl,
        o.source ?? "floor", o.source === "kpi" ? `${tid}:${o.kpi}:seed-${n}` : null, category === "sla" || category === "client" ? 1 : 0,
        itype, hours, amount, resolvedAt ? resolution : null, o.kpi ?? null, iso(due), ack ? iso(ack) : null,
        iso(o.created), events.at(-1)![0], resolvedAt);
      for (const e of events)
        run(db, "INSERT INTO issue_events (issue_id, at, actor_id, type, from_value, to_value, note) VALUES (?,?,?,?,?,?,?)",
          id, e[0], e[1], e[2], e[3], e[4], e[5]);
      return id;
    };

    const KPI_TPL: Record<string, (typeof TEMPLATES)[number]> = {
      sl: ["sla", "high", "Service level off target 3 days running", "none", [0, 0], "Re-planned breaks and moved 2 agents from email to voice; SL back above target."],
      aht: ["quality", "medium", "AHT off target 3 days running", "none", [0, 0], "Call listening found a new verification step; refresher delivered, AHT normalised."],
      absenteeism: ["staffing", "medium", "Absenteeism off target 3 days running", "none", [0, 0], "Return-to-work interviews done; two cases referred to HR."],
    };

    for (let back = 60; back >= 1; back--) {
      const day = addDays(now, -back);
      const dow = day.getUTCDay();
      const count = r.int(2, 4) + (dow === 1 ? 2 : 0);
      for (let k = 0; k < count; k++) {
        let team = r.pick(TEAMS);
        let tpl = r.pick(TEMPLATES);
        if (dow === 1 && k < 2) { team = TEAMS[4]; tpl = TEMPLATES[0]; } // Monday no-shows on Courier Day
        const created = new Date(`${dayOf(day)}T${String(r.int(6, 20)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}:00.000Z`);
        const ups = r.chance(0.55) ? 0 : r.chance(0.6) ? 1 : r.chance(0.7) ? 2 : 3;
        const window = P.resolveHours[tpl[1]] * 60;
        addIssue({ team, tpl, created, ups, resolvedAfterMin: Math.round(window * r.between(0.1, r.chance(0.2) ? 1.6 : 0.95)) });
      }
      // KPI-driven actions in history, as the performance-management job would have raised them
      if (back % 9 === 0) {
        const kpi = r.pick(["sl", "aht", "absenteeism"]);
        const created = new Date(`${dayOf(day)}T07:00:00.000Z`);
        addIssue({ team: r.pick(TEAMS), tpl: KPI_TPL[kpi], created, ups: 0, resolvedAfterMin: Math.round(72 * 60 * r.between(0.3, 1.3)), source: "kpi", kpi });
      }
    }

    // Open right now: [team, template, levels up, minutes ago, picked up, due in minutes (optional), source]
    const live: [number, number, number, number, boolean, number | undefined, string?][] = [
      [4, 0, 0, 25, true, undefined],
      [0, 3, 1, 70, true, 120],
      [1, 6, 2, 140, true, 90, "telegram"],
      [6, 4, 0, 12, false, undefined, "google_chat"],
      [2, 8, 2, 300, true, 600],
      [5, 1, 0, 45, true, undefined],
      [3, 10, 0, 90, true, undefined],
      [7, 7, 1, 50, true, 400],
      [0, 5, 0, 8, false, undefined],
      [5, 12, 1, 200, true, 1440],
      [1, 2, 0, 35, true, undefined],
      [6, 13, 0, 400, true, 5000],
      [3, 3, 3, 900, true, -60], // at COO, overdue: nothing above to move it to — it stays visible as overdue
    ];
    for (const [ti, tpi, ups, ago, acked, dueIn, source] of live)
      addIssue({ team: TEAMS[ti], tpl: TEMPLATES[tpi], created: addMinutes(now, -ago), ups, resolvedAfterMin: null, acked, dueInMin: dueIn, source });

    // Chat groups: one per team, split across Google Chat and Telegram.
    TEAMS.forEach(([tid, name], i) => {
      const src = i % 2 === 0 ? "google_chat" : "telegram";
      run(db, "INSERT INTO chat_groups VALUES (?,?,?,?,?)", `g-${tid}`, src,
        src === "google_chat" ? `spaces/AAA${tid.replace(/-/g, "").toUpperCase()}` : String(-1001000000000 - i), `${name} — floor`, tid);
    });
    const msgs: [string, string, string, number][] = [
      ["g-t-kcs-1", "Denis Hoxha", "Morning all, 20 of 22 logged in, 2 on the way", 190],
      ["g-t-kcs-1", "Agent 14", "🚩 Klarna app refunds page throws error 500 for customers, contacts rising", 22],
      ["g-t-kcs-2", "Anna Russo", "#issue queue over 180, wait time 5 min, need people from email", 16],
      ["g-t-jec-1", "Ergys Shehu", "3 no show today, calling them now", 95],
      ["g-t-jec-1", "Ergys Shehu", "#issue still 3 short after calls, need overtime approval for afternoon", 14],
      ["g-t-jec-2", "Martina Greco", "URGENT dialer freezing for the whole floor, agents can't log in", 6],
      ["g-t-jei-1", "Besa Meta", "Client asked us to stop using the old voucher script from tomorrow #issue", 40],
      ["g-t-jei-2", "Luca Marino", "all good on Roma, 12/12", 120],
      ["g-t-kds-1", "Klevis Brahimi", "chargeback tool login slow but working", 75],
    ];
    msgs.forEach(([g, author, text, ago], i) => {
      const flagged = /(#issue|🚩|URGENT)/i.test(text) ? 1 : 0;
      run(db, "INSERT INTO chat_messages (id, group_id, external_id, author, text, sent_at, flagged) VALUES (?,?,?,?,?,?,?)",
        randomUUID(), g, `seed-${i}`, author, text, iso(addMinutes(now, -ago)), flagged);
    });

    // Handovers: last shift's notes for each team; half acknowledged.
    TEAMS.forEach(([tid, name, , , tl], i) => {
      const at = addMinutes(now, -r.int(60, 400));
      run(db, `INSERT INTO handovers (id, team_id, date, shift_id, author_id, notes, headcount_note, acknowledged_by, acknowledged_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), tid, dayOf(at), i % 3 === 0 ? "s-night" : "s-morning", tl,
        r.pick([
          `${name}: queue stable at close. Two agents on sick leave tomorrow, covered by swap. Watch the CRM slowness after 13:00.`,
          `${name}: client callback list shared in the space. One agent in coaching. Nothing blocking.`,
          `${name}: handed 6 open tickets to the next shift; refund script change goes live tomorrow.`,
        ]),
        `${r.int(10, 22)} planned, ${r.int(1, 3)} absences confirmed`,
        i % 2 === 0 ? tl : null, i % 2 === 0 ? iso(addMinutes(at, 20)) : null, iso(at));
    });
    run(db, "INSERT INTO settings VALUES ('seeded_at', ?)", today);
  });
}
