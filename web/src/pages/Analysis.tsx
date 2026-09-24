import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, ListPlus, TriangleAlert } from "lucide-react";
import { fmtKpi, useApi, type Exception } from "../api";
import { NewIssueModal, Skeleton, useApp } from "../components/ui";
import { PeriodPicker, RagChip, Sparkline, useKpiDefs } from "../components/kpi";

interface Mover { node_id: string; node_name: string; label: string; level: string; kpi: string; kpi_name: string; unit: string; value: number; prev: number; delta: number; better: boolean; score: number }
interface LeagueRow { node_id: string; name: string; label: string; value: number; target: number; rag: "green" | "amber" | "red" | "none"; volume: number; vs_target: number; rank: number; quartile: number }

/** KPIs off target, why, and whether someone owns the fix. */
export function ExceptionList({ rows }: { rows: Exception[] | null }) {
  const { openIssue } = useApp();
  const [creating, setCreating] = useState<Exception | null>(null);
  if (!rows) return <Skeleton />;
  if (!rows.length) return <div className="empty">Every KPI is on or near target.</div>;
  return (
    <div>
      {rows.map((e) => (
        <div key={`${e.node_id}-${e.kpi}`} className="exc">
          <div className="stack" style={{ gap: 4 }}>
            <div className="row"><b>{e.label}</b><span className="faint small">{e.node_name}</span></div>
            <div className="row small">
              <RagChip rag="red" compact /><span><b>{e.kpi_name}</b> {fmtKpi(e.unit, e.value)} vs target {fmtKpi(e.unit, e.target)}</span>
            </div>
            {e.drivers.length > 0 && (
              <div className="row" aria-label="Likely drivers">
                {e.drivers.map((d) => <span key={d.code} className="driver"><TriangleAlert size={12} aria-hidden />{d.text}</span>)}
              </div>
            )}
          </div>
          <div title="Last 7 days"><Sparkline values={e.spark} /></div>
          <div>
            {e.open_action
              ? <button className="btn sm" onClick={() => openIssue(e.open_action!.id)}>{e.open_action.ref} · {e.open_action.owner_name}</button>
              : <button className="btn sm primary" onClick={() => setCreating(e)}><ListPlus size={14} aria-hidden />Open action</button>}
          </div>
        </div>
      ))}
      {creating && (
        <NewIssueModal onClose={() => setCreating(null)} teamId={creating.team_ids[0]} preset={{
          title: `${creating.kpi_name} off target: ${fmtKpi(creating.unit, creating.value)} vs ${fmtKpi(creating.unit, creating.target)}`,
          description: creating.drivers.length ? `Likely drivers: ${creating.drivers.map((d) => d.text).join("; ")}.` : "",
          kpi: creating.kpi, category: creating.kpi === "sl" || creating.kpi === "asa" || creating.kpi === "abandon" ? "sla" : ["adherence", "absenteeism", "attrition", "shrinkage"].includes(creating.kpi) ? "staffing" : "quality",
          severity: creating.severity >= 2 ? "high" : "medium",
        }} />
      )}
    </div>
  );
}

export function Analysis() {
  const [days, setDays] = useState("7");
  const defs = useKpiDefs();
  const exc = useApi<Exception[]>(`/analysis/exceptions?days=${days}`);
  const mv = useApi<{ improving: Mover[]; declining: Mover[] }>(`/analysis/movers?days=${days}`);
  const [kpi, setKpi] = useState("sl");
  const [level, setLevel] = useState<"team" | "FM">("team");
  const lg = useApi<LeagueRow[]>(`/analysis/league?days=${days}&kpi=${kpi}&level=${level}`);
  const def = defs.get(kpi);

  const moverList = (rows: Mover[] | undefined, up: boolean) => (
    !rows ? <Skeleton rows={2} /> : !rows.length ? <div className="empty">Nothing moved by more than half a tolerance band.</div> : (
      <table><tbody>{rows.map((m) => (
        <tr key={`${m.node_id}-${m.kpi}`}>
          <td>{up ? <ArrowUpRight size={16} className="rag-green" aria-label="improving" /> : <ArrowDownRight size={16} className="rag-red" aria-label="worsening" />}</td>
          <td><b>{m.label}</b><div className="faint small">{m.kpi_name}</div></td>
          <td className="r num">{fmtKpi(m.unit, m.prev)} → <b>{fmtKpi(m.unit, m.value)}</b></td>
        </tr>
      ))}</tbody></table>
    )
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Analysis</h1><p>What's off target and why, what moved against the previous period, and how teams rank against their own targets.</p></div>
        <PeriodPicker value={days} onChange={setDays} />
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Exceptions</h2><span className="faint small">team-level KPIs in red (finance at account level), worst first · drivers explain service-level misses</span></div>
        <ExceptionList rows={exc.data} />
      </div>
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card"><div className="card-head"><h2>Declining</h2><span className="faint small">vs previous period</span></div>{moverList(mv.data?.declining, false)}</div>
        <div className="card"><div className="card-head"><h2>Improving</h2><span className="faint small">vs previous period</span></div>{moverList(mv.data?.improving, true)}</div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>League table</h2>
          <div className="row">
            <select className="inline-select" aria-label="KPI" value={kpi} onChange={(e) => setKpi(e.target.value)}>
              {[...defs.values()].map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
            <select className="inline-select" aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as "team" | "FM")}>
              <option value="team">Teams</option><option value="FM">Floor Managers</option>
            </select>
          </div>
        </div>
        <div className="table-wrap">
          {!lg.data || !def ? <Skeleton /> : (
            <table>
              <thead><tr><th className="r">#</th><th>Team / manager</th><th className="r">{def.name}</th><th className="r">Target</th><th className="r">vs target</th><th>Status</th><th className="r">Quartile</th><th className="r">Volume</th></tr></thead>
              <tbody>{lg.data.map((r) => (
                <tr key={r.node_id}>
                  <td className="r num">{r.rank}</td>
                  <td><b>{r.label}</b><div className="faint small">{r.name}</div></td>
                  <td className="r num">{fmtKpi(def.unit, r.value)}</td>
                  <td className="r num">{fmtKpi(def.unit, r.target)}</td>
                  <td className="r num">{def.better === "band" ? `${r.vs_target.toFixed(1)} bands` : `${r.vs_target > 0 ? "+" : ""}${r.vs_target.toFixed(1)}%`}</td>
                  <td><RagChip rag={r.rag} /></td>
                  <td className="r num">Q{r.quartile}</td>
                  <td className="r num">{r.volume.toLocaleString("en-GB")}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <p className="faint small" style={{ padding: "0 16px" }}>Ranked on variance to each team's own target, so different campaigns compare fairly.</p>
      </div>
    </>
  );
}
