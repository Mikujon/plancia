import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { ROLE_NAME, useApi, type DueSummary, type Exception, type IssueRow, type ScoreNode } from "../api";
import { IssueList, Kpi, NewIssueModal, Skeleton, useApp } from "../components/ui";
import { KpiCell, KpiTile, PeriodPicker, useKpiDefs } from "../components/kpi";
import { StaffingTable, type StaffingRow } from "./Staffing";
import { HandoverCard, type HandoverRow } from "./Handovers";
import { ExceptionList } from "./Analysis";

export const HEADLINE = ["sl", "abandon", "asa", "aht", "adherence", "absenteeism", "qa", "csat"];
export const HEADLINE_FIN = [...HEADLINE, "cost_per_contact", "margin"];

/**
 * Overview for every layer of the hierarchy. The same page, scoped by the server to the viewer's subtree:
 * how am I doing (KPIs vs target), who below me is off (direct reports), what's broken (exceptions),
 * and what's due (actions and dates).
 */
export function Home() {
  const { me } = useApp();
  const [days, setDays] = useState("7");
  const [creating, setCreating] = useState(false);
  const defs = useKpiDefs();
  const tree = useApi<ScoreNode>(`/kpis/scorecard?days=${days}`);
  const exc = useApi<Exception[]>(`/analysis/exceptions?days=${days}`);
  const due = useApi<DueSummary>("/actions/due", 60_000);
  const mine = useApi<IssueRow[]>("/issues?status=open&owner=me", 60_000);
  const t = tree.data;
  const codes = (defs.has("margin") ? HEADLINE_FIN : HEADLINE).filter((c) => defs.has(c));
  const byManager = new Map((due.data?.by_manager ?? []).map((m) => [m.user_id, m]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t ? t.label : "…"}</h1>
          <p>{ROLE_NAME[me.role]} · {me.name}. KPIs against target, who below you is off, and what's due.</p>
        </div>
        <div className="row">
          <PeriodPicker value={days} onChange={setDays} />
          <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />New action</button>
        </div>
      </div>

      {!t ? <Skeleton rows={4} /> : (
        <div className="grid g6" style={{ marginBottom: 16 }}>
          {codes.map((c) => <KpiTile key={c} def={defs.get(c)!} k={t.kpis[c]} onClick={() => { location.hash = `#/kpis?node=${t.id}&kpi=${c}`; }} />)}
        </div>
      )}

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi label="Overdue actions" value={due.data?.overdue ?? "…"} sub={`${due.data?.due_today ?? 0} due today · ${due.data?.due_week ?? 0} this week`} alert={(due.data?.overdue ?? 0) > 0} />
        <Kpi label="Not picked up" value={due.data?.not_picked_up ?? "…"} sub="waiting for their owner" alert={(due.data?.not_picked_up ?? 0) > 0} />
        <Kpi label="Closed on time, 30 days" value={due.data?.on_time_pct != null ? `${due.data.on_time_pct}%` : "—"} sub={`${due.data?.closed_30d ?? 0} closed${due.data?.avg_days_late != null ? ` · late ones by ${due.data.avg_days_late} d` : ""}`} />
        <Kpi label="KPIs off target" value={exc.data?.length ?? "…"} sub={exc.data?.filter((e) => !e.open_action).length ? `${exc.data.filter((e) => !e.open_action).length} without an action` : "all have an action"} alert={(exc.data?.filter((e) => !e.open_action).length ?? 0) > 0} />
      </div>

      {t && t.children.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h2>{me.role === "COO" ? "Accounts (CSDM)" : me.role === "CSDM" ? "Floor Managers" : me.role === "FM" ? "Team Leaders" : "Teams"}</h2>
            <a className="small row" style={{ gap: 4, display: "inline-flex" }} href="#/kpis">Full scorecard<ArrowRight size={14} aria-hidden /></a>
          </div>
          <div className="table-wrap">
            <table className="tree">
              <thead><tr>
                <th>Who</th><th className="r">Volume</th>
                {codes.map((c) => <th key={c} className="r" title={defs.get(c)!.formula}>{defs.get(c)!.name}</th>)}
                <th className="r">Overdue</th><th className="r">On time</th>
              </tr></thead>
              <tbody>
                {t.children.map((n) => {
                  const m = byManager.get(n.id);
                  return (
                    <tr key={n.id} className="click" tabIndex={0} onClick={() => { location.hash = `#/kpis?node=${n.id}`; }} onKeyDown={(e) => e.key === "Enter" && (location.hash = `#/kpis?node=${n.id}`)}>
                      <td><b>{n.label}</b><div className="faint small">{n.name}</div></td>
                      <td className="r num">{n.volume.toLocaleString("en-GB")}</td>
                      {codes.map((c) => <td key={c} className="r"><KpiCell def={defs.get(c)!} k={n.kpis[c]} /></td>)}
                      <td className="r num">{m ? (m.overdue ? <span className="chip bad">{m.overdue}</span> : "0") : "—"}</td>
                      <td className="r num">{m?.on_time_pct != null ? `${m.on_time_pct}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Exceptions</h2><a className="small row" style={{ gap: 4, display: "inline-flex" }} href="#/analysis">Analysis<ArrowRight size={14} aria-hidden /></a></div>
            <ExceptionList rows={exc.data ? exc.data.slice(0, 6) : null} />
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>My actions</h2><a className="small row" style={{ gap: 4, display: "inline-flex" }} href="#/actions">All actions<ArrowRight size={14} aria-hidden /></a></div>
            <IssueList rows={mine.data} empty="Nothing waiting on you." />
          </div>
          {me.role === "TL" && <TlFloor />}
        </div>
      </div>
      {creating && <NewIssueModal onClose={() => setCreating(false)} />}
    </>
  );
}

/** A TL also runs the shift: live headcount and the handover. */
function TlFloor() {
  const { me, org } = useApp();
  const staffing = useApi<StaffingRow[]>("/staffing", 60_000);
  const handovers = useApi<HandoverRow[]>("/handovers?limit=10");
  const myTeams = org.teams.filter((t) => t.tl_id === me.id);
  const last = myTeams.map((t) => (handovers.data ?? []).find((h) => h.team_id === t.id)).filter(Boolean) as HandoverRow[];
  return (
    <>
      <div className="card"><div className="card-head"><h2>My team now</h2><a href="#/staffing" className="small">Workforce</a></div><StaffingTable rows={staffing.data} compact /></div>
      {last.map((h) => <HandoverCard key={h.id} h={h} />)}
    </>
  );
}
