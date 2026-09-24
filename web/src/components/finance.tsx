import { eur, eurShort } from "../api";
import { Bars, useSort } from "./ui";

export interface Rollup {
  from: string; to: string; updated_through: string | null;
  rows: { campaign_id: string; campaign_name: string; client_id: string; client_name: string; revenue: number; labour_cost: number; sla_penalty: number; margin: number; margin_pct: number; issue_cost: number; issues: number; sla_days_missed: number; days: number; open_issues: number; open_risk: number }[];
  totals: { revenue: number; labour_cost: number; sla_penalty: number; margin: number; margin_pct: number; issue_cost: number; open_risk: number; open_issues: number };
  daily: { date: string; revenue: number; margin: number; issue_cost: number; sla_penalty: number; margin_pct: number }[];
}

export function RollupTable({ r }: { r: Rollup }) {
  const { sorted, th } = useSort(r.rows, { key: "margin", dir: "desc" });
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>
          {th("campaign_name", "Campaign")}{th("revenue", "Revenue", true)}{th("labour_cost", "Labour", true)}{th("sla_penalty", "SLA penalties", true)}
          {th("margin", "Margin", true)}{th("margin_pct", "Margin %", true)}{th("issue_cost", "Issue cost", true)}{th("sla_days_missed", "SLA missed", true)}{th("open_risk", "Open risk", true)}
        </tr></thead>
        <tbody>
          {(sorted ?? []).map((x) => (
            <tr key={x.campaign_id}>
              <td><b>{x.campaign_name}</b></td>
              <td className="r num">{eurShort(x.revenue)}</td>
              <td className="r num">{eurShort(x.labour_cost)}</td>
              <td className="r num" style={{ color: x.sla_penalty ? "var(--danger)" : undefined }}>{x.sla_penalty ? eurShort(x.sla_penalty) : "—"}</td>
              <td className="r num"><b>{eurShort(x.margin)}</b></td>
              <td className="r num">{x.margin_pct.toFixed(1)}%</td>
              <td className="r num">{eurShort(x.issue_cost)}</td>
              <td className="r num">{x.sla_days_missed}/{x.days} d</td>
              <td className="r num">{x.open_issues} · {eur(x.open_risk)}</td>
            </tr>
          ))}
          <tr>
            <td><b>Total</b></td>
            <td className="r num"><b>{eurShort(r.totals.revenue)}</b></td>
            <td className="r num">{eurShort(r.totals.labour_cost)}</td>
            <td className="r num">{eurShort(r.totals.sla_penalty)}</td>
            <td className="r num"><b>{eurShort(r.totals.margin)}</b></td>
            <td className="r num"><b>{r.totals.margin_pct.toFixed(1)}%</b></td>
            <td className="r num">{eurShort(r.totals.issue_cost)}</td>
            <td></td>
            <td className="r num">{r.totals.open_issues} · {eur(r.totals.open_risk)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function MarginTrend({ r }: { r: Rollup }) {
  return (
    <div className="card card-pad stack">
      <div className="row between"><h3>Daily margin</h3><span className="faint small">updated through {r.updated_through}</span></div>
      <Bars label="Daily margin; hatched bars are days with an SLA penalty" data={r.daily.map((d) => ({ label: d.date, value: d.margin, tone: d.sla_penalty > 0 ? "bad" : undefined }))} format={(n) => eur(n)} />
      <div className="legend">
        <span><i className="swatch" style={{ background: "var(--accent)" }} />Margin</span>
        <span><i className="swatch" style={{ background: "repeating-linear-gradient(45deg, var(--danger-solid) 0 3px, var(--surface) 3px 4px)" }} />SLA penalty day ({r.daily.filter((d) => d.sla_penalty > 0).length})</span>
      </div>
      <div className="row between faint small"><span>{r.daily[0]?.date}</span><span>{r.daily.at(-1)?.date}</span></div>
    </div>
  );
}
