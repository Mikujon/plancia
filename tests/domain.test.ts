import { describe, expect, it } from "vitest";
import { gapCost, impactAmount } from "../server/domain/cost.ts";
import { autoEscalation, dueState, escalatedDue, initialDue } from "../server/domain/escalation.ts";
import {
  createIssue, dueSummary, escalateIssue, getIssue, listIssues, resolveIssue, runAutoEscalation, updateIssue,
} from "../server/domain/issues.ts";
import { chainAbove, userById, visibleTeamIds } from "../server/domain/org.ts";
import { addInto, flatten, KPI, rag, scorecard, zero, type Agg } from "../server/domain/kpi.ts";
import { exceptions, league, raiseKpiActions, slDrivers } from "../server/domain/analysis.ts";
import { opsReport, qbr } from "../server/domain/reports.ts";
import { ingest, messageToIssue, triage } from "../server/domain/chat.ts";
import { parseTelegramUpdate } from "../server/adapters/chat/telegram.ts";
import { parseGoogleChatEvent } from "../server/adapters/chat/google-chat.ts";
import { shiftWindow } from "../server/domain/time.ts";
import { all } from "../server/db.ts";
import type { Issue } from "../server/domain/types.ts";
import { makeTestApp } from "./helpers.ts";

const camp = { hourly_cost: 10, billing_rate: 20, overtime_multiplier: 1.5, sla_penalty_per_day: 1000, sla_target_pct: 80 };
const agg = (p: Partial<Agg>): Agg => ({ ...zero(), ...p });
const period = { from: "2026-09-17", to: "2026-09-24" };

describe("cost", () => {
  it("prices each kind of impact", () => {
    expect(impactAmount(camp, "overtime", 4)).toBe(60);
    expect(impactAmount(camp, "understaffing", 4)).toBe(80);
    expect(impactAmount(camp, "sla_penalty", 0)).toBe(1000);
    expect(impactAmount(camp, "sla_penalty", 0, 250)).toBe(250);
    expect(gapCost(camp, 3, 2.5)).toBe(150);
  });
});

describe("due dates and the two clocks", () => {
  const t0 = new Date("2026-09-24T10:00:00.000Z");
  const base = { status: "open", severity: "high", layer_since: t0.toISOString(), acknowledged_at: null, due_at: initialDue(t0, "high"), resolved_at: null } as const;
  it("sets the due date from severity", () => {
    expect(initialDue(t0, "critical")).toBe("2026-09-24T14:00:00.000Z");
    expect(initialDue(t0, "medium")).toBe("2026-09-27T10:00:00.000Z");
  });
  it("escalates when not picked up, or when overdue — not before", () => {
    expect(autoEscalation(base, new Date("2026-09-24T10:29:00Z"))).toBeNull();
    expect(autoEscalation(base, new Date("2026-09-24T10:30:00Z"))).toBe("not_picked_up");
    const taken = { ...base, acknowledged_at: "2026-09-24T10:05:00.000Z" };
    expect(autoEscalation(taken, new Date("2026-09-25T09:59:00Z"))).toBeNull();
    expect(autoEscalation(taken, new Date("2026-09-25T10:00:00Z"))).toBe("overdue");
  });
  it("gives the next owner a fresh, shorter window — never an earlier date", () => {
    expect(escalatedDue({ due_at: "2026-09-24T11:00:00.000Z", severity: "high" }, t0)).toBe("2026-09-24T22:00:00.000Z");
    expect(escalatedDue({ due_at: "2026-09-26T00:00:00.000Z", severity: "high" }, t0)).toBe("2026-09-26T00:00:00.000Z");
  });
  it("classifies due state", () => {
    expect(dueState(base, new Date("2026-09-25T11:00:00Z"))).toBe("overdue");
    expect(dueState(base, new Date("2026-09-24T12:00:00Z"))).toBe("due_soon");
    expect(dueState({ ...base, status: "resolved", resolved_at: "2026-09-26T00:00:00.000Z" }, t0)).toBe("done_late");
  });
});

describe("hierarchy: COO → CSDM → Floor Manager → Team Leader", () => {
  const { deps } = makeTestApp();
  it("has one reporting line per person", () => {
    expect(chainAbove(deps.db, "u-tl-5").map((u) => u.role)).toEqual(["FM", "CSDM", "COO"]);
    expect(chainAbove(deps.db, "u-tl-5").map((u) => u.id)).toEqual(["u-fm-c", "u-csdm-je", "u-coo"]);
  });
  it("shows each person their own subtree", () => {
    const ids = (u: string) => [...visibleTeamIds(deps.db, userById(deps.db, u))].sort();
    expect(ids("u-tl-5")).toEqual(["t-jec-1"]);
    expect(ids("u-fm-c")).toEqual(["t-jec-1", "t-jec-2"]);
    expect(ids("u-csdm-je")).toEqual(["t-jec-1", "t-jec-2", "t-jei-1", "t-jei-2"]);
    expect(ids("u-coo")).toHaveLength(8);
  });
});

describe("action lifecycle", () => {
  it("moves one level at a time on each missed clock, with the chain and the dates on record", () => {
    const { deps, advance } = makeTestApp();
    runAutoEscalation(deps);
    // arrives from the system (e.g. RTA), so the TL still has to pick it up
    const i = createIssue(deps, null, { team_id: "t-jec-1", title: "Queue over target", category: "sla", severity: "high", impact_type: "sla_penalty" });
    expect(i.owner_id).toBe("u-tl-5");
    expect(i.due_at).toBe("2026-09-25T10:30:00.000Z");
    expect(i.impact_amount).toBe(1500);

    advance(31); // not picked up within 30 min
    runAutoEscalation(deps);
    let got = getIssue(deps, null, i.id);
    expect(got.issue.owner_id).toBe("u-fm-c");
    expect(got.issue.layer).toBe("FM");

    // the FM takes it: the pick-up clock stops, the due date clock keeps running
    const fm = userById(deps.db, "u-fm-c");
    updateIssue(deps, fm, i.id, { status: "in_progress" });
    advance(60);
    expect(runAutoEscalation(deps)).not.toContain(i.id);

    advance(24 * 60); // past the due date
    runAutoEscalation(deps);
    got = getIssue(deps, null, i.id);
    expect(got.issue.owner_id).toBe("u-csdm-je");
    expect(got.chain.map((s) => `${s.layer}:${s.how}`)).toEqual(["TL:raised", "FM:auto", "CSDM:auto"]);
    expect(got.issue.due_state).not.toBe("overdue"); // fresh window at CSDM

    // the TL can follow but not act any more; the CSDM (or the COO) can
    expect(() => escalateIssue(deps, userById(deps.db, "u-tl-5"), i.id, "trying")).toThrow(/CSDM layer/);
    resolveIssue(deps, userById(deps.db, "u-csdm-je"), i.id, { resolution: "Overflow agreed with client", impact_amount: 900 });
    got = getIssue(deps, null, i.id);
    expect(got.issue.status).toBe("resolved");
    expect(got.events.filter((e) => e.type === "due").length).toBeGreaterThanOrEqual(2);
  });

  it("asks for a reason to push a due date out, and a manager's own action starts picked up", () => {
    const { deps } = makeTestApp();
    const fm = userById(deps.db, "u-fm-a");
    const i = createIssue(deps, fm, { team_id: "t-kcs-2", title: "AHT review", category: "quality", severity: "medium" });
    expect(i.owner_id).toBe("u-fm-a");
    expect(i.acknowledged_at).not.toBeNull();
    const later = new Date(Date.parse(i.due_at) + 86_400_000).toISOString();
    expect(() => updateIssue(deps, fm, i.id, { due_at: later })).toThrow(/why/);
    expect(updateIssue(deps, fm, i.id, { due_at: later, due_reason: "Waiting for client calibration" }).due_at).toBe(later);
  });

  it("never moves anything above the COO", () => {
    const { deps } = makeTestApp();
    const coo = userById(deps.db, "u-coo");
    const i = createIssue(deps, coo, { team_id: "t-kcs-1", title: "Contract review", category: "client", severity: "critical" });
    expect(() => escalateIssue(deps, coo, i.id, "up")).toThrow(/top/);
  });

  it("measures due-date discipline for the perimeter and per direct report", () => {
    const { deps } = makeTestApp();
    const s = dueSummary(deps, userById(deps.db, "u-csdm-kl"));
    expect(s.closed_30d).toBeGreaterThan(0);
    expect(s.on_time_pct).toBeGreaterThan(0);
    expect(s.by_manager.map((m) => m.user_id).sort()).toEqual(["u-fm-a", "u-fm-b"]);
  });
});

describe("KPI engine", () => {
  it("aggregates as a ratio of sums, never an average of averages", () => {
    const small = agg({ offered: 100, answered_in_sl: 90 });
    const big = agg({ offered: 1000, answered_in_sl: 700 });
    const node = addInto(addInto(zero(), small), big);
    expect(KPI.sl.value(node)).toBeCloseTo((790 / 1100) * 100, 5); // 71.8%, not the 80% average
  });
  it("rates green / amber / red by direction", () => {
    expect(rag(KPI.sl, 81, 80, 5)).toBe("green");
    expect(rag(KPI.sl, 77, 80, 5)).toBe("amber");
    expect(rag(KPI.sl, 74, 80, 5)).toBe("red");
    expect(rag(KPI.aht, 380, 360, 20)).toBe("amber");
    expect(rag(KPI.occupancy, 93, 85, 5)).toBe("amber"); // band: too busy is also a problem
    expect(rag(KPI.occupancy, 70, 85, 5)).toBe("red");
  });
  it("builds the scorecard along the reporting line, with account totals that add up", () => {
    const { deps } = makeTestApp();
    const tree = scorecard(deps, userById(deps.db, "u-coo"), period);
    expect(tree.level).toBe("COO");
    expect(tree.children.map((c) => c.level)).toEqual(["CSDM", "CSDM"]);
    expect(tree.children[0].children.every((c) => c.level === "FM")).toBe(true);
    expect(flatten(tree).filter((n) => n.level === "TL")).toHaveLength(8);
    const kl = tree.children.find((c) => c.id === "u-csdm-kl")!;
    const [{ sl }] = all<{ sl: number }>(deps.db, `SELECT 100.0 * SUM(answered_in_sl) / SUM(offered) AS sl FROM kpi_daily
      WHERE team_id LIKE 't-k%' AND date >= ? AND date < ?`, period.from, period.to);
    expect(kl.kpis.sl.value).toBeCloseTo(sl, 1);
  });
  it("keeps finance KPIs for CSDM and COO", () => {
    const { deps } = makeTestApp();
    expect(scorecard(deps, userById(deps.db, "u-fm-a"), period).kpis.margin).toBeUndefined();
    expect(scorecard(deps, userById(deps.db, "u-csdm-kl"), period).kpis.margin).toBeDefined();
  });
});

describe("analysis", () => {
  it("names the drivers of a service-level miss", () => {
    const a = agg({ offered: 1100, forecast: 1000, logged_hours: 80, required_hours: 100, answered: 1000, handle_hours: 1000 * 400 / 3600, adherent_hours: 72, paid_hours: 120, absent_hours: 12 });
    const adverse = slDrivers(a, 360).filter((x) => x.adverse).map((x) => x.code);
    expect(adverse).toEqual(expect.arrayContaining(["volume", "staffing", "aht", "absenteeism"]));
    expect(adverse[0]).toBe("staffing");
  });
  it("finds the planted pattern: KCS Bravo off target on service level, driven by AHT", () => {
    const { deps } = makeTestApp();
    const exc = exceptions(deps, userById(deps.db, "u-coo"), period);
    const bravo = exc.find((e) => e.label === "KCS Bravo" && e.kpi === "sl");
    expect(bravo).toBeDefined();
    expect(bravo!.drivers.map((d) => d.code)).toContain("aht");
    expect(exc.some((e) => e.label === "Care IT Roma" && e.kpi === "qa")).toBe(true);
  });
  it("ranks teams on variance to their own target, so different campaigns compare fairly", () => {
    const { deps } = makeTestApp();
    const l = league(deps, userById(deps.db, "u-coo"), period, "aht");
    expect(l).toHaveLength(8);
    expect(l.at(-1)!.label).toBe("KCS Bravo"); // the AHT drift, although Disputes has the longest raw AHT
    expect(l.at(-1)!.quartile).toBe(4);
  });
  it("opens one owned action per team and KPI after three red days, and not twice", () => {
    const { deps } = makeTestApp();
    const first = raiseKpiActions(deps);
    const rows = listIssues(deps, null, { kpi: "sl", team_id: "t-kcs-2" });
    expect(rows.length).toBe(1);
    expect(rows[0].owner_id).toBe("u-tl-2");
    expect(rows[0].source).toBe("kpi");
    expect(first.length).toBeGreaterThan(0);
    expect(raiseKpiActions(deps)).toEqual([]);
  });
});

describe("reports", () => {
  it("builds the daily report and the weekly review for a manager", () => {
    const { deps } = makeTestApp();
    const fm = userById(deps.db, "u-fm-a");
    const day = opsReport(deps, fm, "day");
    expect(day.period).toEqual({ from: "2026-09-23", to: "2026-09-24" });
    expect(day.scorecard.map((r) => r.level)).toEqual(["FM", "TL", "TL"]);
    expect(day.finance).toBeNull();
    const week = opsReport(deps, userById(deps.db, "u-coo"), "week");
    expect(week.markdown).toContain("Weekly business review");
    expect(week.finance).not.toBeNull();
  });
  it("keeps margin out of the client QBR text", () => {
    const { deps } = makeTestApp();
    const q = qbr(deps, userById(deps.db, "u-csdm-je"), { client_id: "cl-justeat" });
    expect(q.markdown).toContain("Service level");
    expect(q.markdown.toLowerCase()).not.toContain("margin");
    expect(q.internal.margin).toBeGreaterThan(0);
  });
});

describe("shift windows", () => {
  const night = { id: "n", name: "Night", start_hhmm: "22:00", end_hhmm: "06:00" };
  it("puts the hours after midnight in yesterday's night shift", () => {
    expect(shiftWindow(night, new Date("2026-09-24T02:00:00Z"))).toEqual({ active: true, hoursLeft: 4, date: "2026-09-23" });
    expect(shiftWindow(night, new Date("2026-09-24T12:00:00Z")).active).toBe(false);
  });
});

describe("chat intake", () => {
  it("turns a flagged group message into an owned action in one call", () => {
    const { deps } = makeTestApp();
    const tg = parseTelegramUpdate({
      update_id: 1, message: { message_id: 77, date: 1790000000, chat: { id: -1001000000001, title: "KCS Bravo", type: "supergroup" },
        from: { first_name: "Anna", last_name: "Russo" }, text: "/issue CTI down for the whole floor" },
    })!;
    const stored = ingest(deps, tg);
    expect(stored.stored).toBe(true);
    expect(ingest(deps, tg).reason).toBe("duplicate");
    const issue = messageToIssue(deps, userById(deps.db, "u-tl-2"), stored.id!) as Issue;
    expect(issue.category).toBe("system");
    expect(issue.severity).toBe("critical");
    expect(issue.owner_id).toBe("u-tl-2");
    const gc = parseGoogleChatEvent({ type: "MESSAGE", space: { name: "spaces/UNKNOWN" }, message: { name: "spaces/UNKNOWN/messages/1", text: "#issue hello" } })!;
    expect(ingest(deps, gc)).toEqual({ stored: false, reason: "group_not_mapped" });
    expect(triage("queue over 200, wait time 5 min").category).toBe("sla");
  });
});
