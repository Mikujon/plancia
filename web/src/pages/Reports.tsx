import { useState } from "react";
import { ArrowLeft, Check, Copy, Download, Printer } from "lucide-react";
import {
  dur, eur, eurShort, fmtKpi, IMPACT_NAME, useApi, when,
  type ChainStep, type DueSummary, type EventRow, type Exception, type IssueRow, type KpiValue, type Role,
} from "../api";
import { Chain, eventText } from "../components/IssueDrawer";
import { ErrorNote, Kpi, LayerChip, SevChip, Skeleton, StatusChip, Tabs, useApp } from "../components/ui";
import { KpiCell, useKpiDefs } from "../components/kpi";
import { MarginTrend, RollupTable, type Rollup } from "../components/finance";
import { ExceptionList } from "./Analysis";

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => day(new Date(Date.now() - n * 86_400_000));

function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); }}>
      {done ? <><Check size={16} aria-hidden />Copied</> : <><Copy size={16} aria-hidden />{label}</>}
    </button>
  );
}

type Tab = "day" | "week" | "qbr" | "pnl";

export function Reports({ clientParam }: { clientParam?: string }) {
  const { me } = useApp();
  const account = me.role === "CSDM" || me.role === "COO";
  const [tab, setTab] = useState<Tab>(clientParam && account ? "qbr" : "day");
  const tabs: [Tab, string][] = [["day", "Daily report"], ["week", "Weekly review"], ...(account ? [["qbr", "Client QBR"], ["pnl", "P&L"]] as [Tab, string][] : [])];
  return (
    <>
      <div className="page-head">
        <div><h1>Reports</h1><p>Management reports for your part of the hierarchy — ready to copy into the daily call, the weekly review or the client QBR.</p></div>
        <Tabs label="Report" value={tab} onChange={setTab} options={tabs} />
      </div>
      {tab === "day" || tab === "week" ? <OpsReport kind={tab} /> : tab === "qbr" ? <QbrReport clientParam={clientParam} /> : <PnlReport />}
    </>
  );
}

interface OpsReportData {
  kind: "day" | "week"; title: string; period: { from: string; to: string }; headline: string[];
  scorecard: { id: string; level: Role | "TEAM"; name: string; label: string; volume: number; kpis: Record<string, KpiValue> }[];
  exceptions: Exception[]; movers: { improving: Mover[]; declining: Mover[] }; due: DueSummary;
  escalations: { total: number; auto: number }; actions_by_kpi: { kpi: string; opened: number; closed: number; on_time: number; open_now: number }[];
  finance: Rollup["totals"] | null; markdown: string;
}
interface Mover { node_id: string; label: string; kpi_name: string; unit: string; value: number; prev: number }

function OpsReport({ kind }: { kind: "day" | "week" }) {
  const defs = useKpiDefs();
  const { data: r, error } = useApi<OpsReportData>(`/reports/ops?kind=${kind}`);
  if (error) return <ErrorNote e={error} />;
  if (!r) return <Skeleton rows={8} />;
  const last = day(new Date(Date.parse(r.period.to) - 86_400_000));
  return (
    <div className="stack">
      <div className="card card-pad row between">
        <div><h2>{r.title}</h2><div className="faint small">{r.period.from === last ? r.period.from : `${r.period.from} → ${last}`} · compared with the {kind === "day" ? "previous day" : "previous 7 days"}</div></div>
        <div className="row">
          <CopyButton text={r.markdown} label="Copy report" />
          <button className="btn" onClick={() => download(`${kind === "day" ? "daily-report" : "weekly-review"}-${last}.md`, r.markdown, "text/markdown")}><Download size={16} aria-hidden />.md</button>
          <button className="btn" onClick={() => window.print()}><Printer size={16} aria-hidden />Print</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Scorecard</h2></div>
        <div className="table-wrap">
          <table className="tree">
            <thead><tr><th></th><th className="r">Volume</th>{r.headline.filter((c) => defs.has(c)).map((c) => <th key={c} className="r">{defs.get(c)!.name}</th>)}</tr></thead>
            <tbody>{r.scorecard.map((n, i) => (
              <tr key={n.id} className={i === 0 ? "sel" : ""}>
                <td>{n.level !== "TEAM" && <LayerChip layer={n.level} />} <b>{n.label}</b>{i > 0 && <span className="faint small"> · {n.name}</span>}</td>
                <td className="r num">{n.volume.toLocaleString("en-GB")}</td>
                {r.headline.filter((c) => defs.has(c)).map((c) => <td key={c} className="r"><KpiCell def={defs.get(c)!} k={n.kpis[c]} /></td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div className="grid g4">
        <Kpi label="Overdue actions" value={r.due.overdue} alert={r.due.overdue > 0} sub={`${r.due.open} open`} />
        <Kpi label="Closed on time, 30 days" value={r.due.on_time_pct != null ? `${r.due.on_time_pct}%` : "—"} sub={`${r.due.closed_30d} closed`} />
        <Kpi label="Escalations" value={r.escalations.total} sub={`${r.escalations.auto} automatic`} />
        {r.finance ? <Kpi label="Gross margin" value={`${r.finance.margin_pct.toFixed(1)}%`} sub={`${eurShort(r.finance.margin)} on ${eurShort(r.finance.revenue)}`} />
          : <Kpi label="KPIs off target" value={r.exceptions.length} />}
      </div>
      <div className="card"><div className="card-head"><h2>Exceptions</h2></div><ExceptionList rows={r.exceptions.slice(0, 10)} /></div>
      <div className="grid g2">
        <div className="card"><div className="card-head"><h2>Declining</h2></div>
          {r.movers.declining.length ? <table><tbody>{r.movers.declining.map((m) => <tr key={m.node_id + m.kpi_name}><td><b>{m.label}</b> · {m.kpi_name}</td><td className="r num">{fmtKpi(m.unit, m.prev)} → <b>{fmtKpi(m.unit, m.value)}</b></td></tr>)}</tbody></table> : <div className="empty">No significant decline.</div>}
        </div>
        <div className="card"><div className="card-head"><h2>Actions linked to KPIs</h2></div>
          {r.actions_by_kpi.length ? <table><thead><tr><th>KPI</th><th className="r">Opened</th><th className="r">Closed</th><th className="r">On time</th><th className="r">Open now</th></tr></thead>
            <tbody>{r.actions_by_kpi.map((a) => <tr key={a.kpi}><td>{defs.get(a.kpi)?.name ?? a.kpi}</td><td className="r num">{a.opened}</td><td className="r num">{a.closed}</td><td className="r num">{a.on_time}</td><td className="r num">{a.open_now}</td></tr>)}</tbody></table>
            : <div className="empty">No KPI actions in this period.</div>}
        </div>
      </div>
    </div>
  );
}

interface Qbr {
  client: { id: string; name: string }; from: string; to: string;
  campaigns: { campaign: { id: string; name: string }; kpis: { kpi: string; name: string; months: { period: string; value: number | null; target: number; rag: string }[]; days_on_target: number; days: number }[] }[];
  totals: { n: number; resolved: number; escalated: number; to_account: number; avg_min: number | null; on_time: number | null };
  internal: { revenue: number; margin: number; margin_pct: number; issue_cost: number; sla_penalty: number };
  markdown: string;
}

function QbrReport({ clientParam }: { clientParam?: string }) {
  const { org, campaignIds } = useApp();
  const defs = useKpiDefs();
  const clients = org.clients.filter((c) => org.campaigns.some((x) => x.client_id === c.id && campaignIds.has(x.id)));
  const [client, setClient] = useState(clientParam && clients.some((c) => c.id === clientParam) ? clientParam : clients[0]?.id ?? "");
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(day(new Date()));
  const { data: q, error } = useApi<Qbr>(client ? `/qbr?client_id=${client}&from=${from}&to=${to}` : null);
  return (
    <div className="stack">
      <div className="card card-pad row">
        <label className="f">Client<select value={client} onChange={(e) => setClient(e.target.value)}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="row" style={{ marginLeft: "auto", alignSelf: "end" }}>
          {q && <CopyButton text={q.markdown} label="Copy for the QBR deck" />}
          {q && <button className="btn" onClick={() => download(`${q.client.name}-QBR-${from}.md`, q.markdown, "text/markdown")}><Download size={16} aria-hidden />.md</button>}
        </div>
      </div>
      <ErrorNote e={error} />
      {!q && !error && <Skeleton rows={6} />}
      {q && q.campaigns.map((c) => (
        <div key={c.campaign.id} className="card">
          <div className="card-head"><h2>{c.campaign.name}</h2><span className="faint small">contract KPIs by month · client-facing</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>KPI</th>{c.kpis[0]?.months.map((m) => <th key={m.period} className="r">{m.period}</th>)}<th className="r">Target</th><th className="r">Days on target</th></tr></thead>
              <tbody>{c.kpis.map((k) => (
                <tr key={k.kpi}>
                  <td><b>{k.name}</b></td>
                  {k.months.map((m) => <td key={m.period} className="r"><KpiCell def={defs.get(k.kpi) ?? { code: k.kpi, name: k.name, unit: "%", better: "higher", group: "", finance: false, formula: "", target: 0, amber: 0 }} k={{ value: m.value, target: m.target, amber: 0, rag: m.rag as KpiValue["rag"], prev: null, delta: null }} /></td>)}
                  <td className="r num">{fmtKpi(defs.get(k.kpi)?.unit ?? "%", k.months.at(-1)?.target)}</td>
                  <td className="r num">{k.days_on_target}/{k.days}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ))}
      {q && (
        <div className="split">
          <div className="card"><div className="card-head"><h2>Client-facing summary</h2><span className="faint small">no margin figures</span></div><div className="card-pad"><pre className="md">{q.markdown}</pre></div></div>
          <div className="card card-pad stack">
            <div className="row between"><h3>Internal — not for the client</h3><span className="chip warn">internal</span></div>
            <div className="grid g2">
              <div><div className="faint small">Revenue</div><b className="num">{eur(q.internal.revenue)}</b></div>
              <div><div className="faint small">Margin</div><b className="num">{eur(q.internal.margin)} · {q.internal.margin_pct.toFixed(1)}%</b></div>
              <div><div className="faint small">SLA penalties</div><b className="num">{eur(q.internal.sla_penalty)}</b></div>
              <div><div className="faint small">Cost logged on issues</div><b className="num">{eur(q.internal.issue_cost)}</b></div>
            </div>
            <div className="small muted">{q.totals.n} issues · {q.totals.resolved} resolved · {q.totals.on_time ?? 0} on time · {q.totals.to_account} reached the account team</div>
          </div>
        </div>
      )}
    </div>
  );
}

function toCsv(r: Rollup) {
  const head = ["campaign", "client", "revenue", "labour_cost", "sla_penalty", "margin", "margin_pct", "issue_cost", "issues", "sla_days_missed", "days", "open_issues", "open_risk"];
  const lines = r.rows.map((x) => [x.campaign_name, x.client_name, x.revenue, x.labour_cost, x.sla_penalty, x.margin, x.margin_pct, x.issue_cost, x.issues, x.sla_days_missed, x.days, x.open_issues, x.open_risk]
    .map((v) => (typeof v === "string" && /[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","));
  return [head.join(","), ...lines].join("\n");
}

function PnlReport() {
  const { org, campaignIds } = useApp();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(day(new Date()));
  const [client, setClient] = useState("");
  const clients = org.clients.filter((c) => org.campaigns.some((x) => x.client_id === c.id && campaignIds.has(x.id)));
  const { data: r } = useApi<Rollup>(`/rollup?from=${from}&to=${to}${client ? `&client_id=${client}` : ""}`);
  return (
    <div className="stack">
      <div className="card card-pad row">
        <label className="f">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="f">Client<select value={client} onChange={(e) => setClient(e.target.value)}><option value="">All in my perimeter</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <div style={{ marginLeft: "auto", alignSelf: "end" }} className="row">
          {r && <button className="btn" onClick={() => download(`plancia-pnl-${from}-${to}.csv`, toCsv(r))}><Download size={16} aria-hidden />CSV</button>}
        </div>
      </div>
      {!r ? <Skeleton rows={6} /> : <>
        <div className="grid g4">
          <Kpi label="Revenue" value={eur(r.totals.revenue)} />
          <Kpi label="Gross margin" value={eur(r.totals.margin)} sub={`${r.totals.margin_pct.toFixed(1)}%`} />
          <Kpi label="SLA penalties" value={eur(r.totals.sla_penalty)} alert={r.totals.sla_penalty > 0} />
          <Kpi label="Cost logged on issues" value={eur(r.totals.issue_cost)} sub="explains leakage — not added on top" />
        </div>
        <div className="card"><RollupTable r={r} /></div>
        <MarginTrend r={r} />
        <p className="faint small">Revenue = logged-in hours × billing rate · labour = paid hours × cost + overtime × cost × OT multiplier · a penalty applies on days the campaign misses its contractual service level. Updated through {r.updated_through}.</p>
      </>}
    </div>
  );
}

interface IssueReportData {
  issue: IssueRow; events: EventRow[]; chain: (ChainStep & { minutes: number })[];
  time_to_resolve_min: number | null; open_for_min: number; escalations: number; auto_escalations: number;
  due_changes: number; on_time: boolean | null;
  cost: { type: string; hours: number; amount: number; day_margin: number | null; share_of_day_margin_pct: number | null };
  campaign: { id: string; name: string; billing_rate: number; hourly_cost: number };
}

/** One issue, from the floor to resolution and its margin effect — one printable page. */
export function IssueReport({ id }: { id: string }) {
  const { org } = useApp();
  const { data: r, error } = useApi<IssueReportData>(`/issues/${id}/report`);
  const names = new Map(org.users.map((u) => [u.id, u.name]));
  if (error) return <ErrorNote e={error} />;
  if (!r) return <Skeleton rows={8} />;
  const i = r.issue;
  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <div className="row"><span className="mono faint">{i.ref}</span><SevChip s={i.severity} /><StatusChip s={i.status} /><span className="chip">{i.category}</span>{i.kpi && <span className="chip">KPI · {i.kpi}</span>}</div>
          <h1 style={{ marginTop: 6 }}>{i.title}</h1>
          <p>{i.campaign_name} · {i.team_name} · raised {when(i.created_at)}{i.source !== "floor" ? ` via ${i.source.replace("_", " ")}` : " on the floor"} · due {when(i.due_at)}</p>
        </div>
        <div className="row no-print"><a className="btn" href="#/actions"><ArrowLeft size={16} aria-hidden />Actions</a><button className="btn primary" onClick={() => window.print()}><Printer size={16} aria-hidden />Print / PDF</button></div>
      </div>
      <div className="grid g4">
        <Kpi label="Time to resolve" value={r.time_to_resolve_min != null ? dur(r.time_to_resolve_min) : "open"} sub={r.on_time == null ? `open for ${dur(r.open_for_min)}` : r.on_time ? "closed within its due date" : "closed after its due date"} alert={r.on_time === false} />
        <Kpi label="Escalations" value={r.escalations} sub={`${r.auto_escalations} automatic · ${r.due_changes} due-date changes`} />
        <Kpi label="Margin effect" value={r.cost.amount ? `−${eur(r.cost.amount)}` : "—"} sub={`${IMPACT_NAME[r.cost.type]}${r.cost.hours ? ` · ${r.cost.hours} h` : ""}`} alert={r.cost.amount > 0} />
        <Kpi label="Share of that day's margin" value={r.cost.share_of_day_margin_pct != null ? `${r.cost.share_of_day_margin_pct}%` : "—"} sub={r.cost.day_margin != null ? `campaign margin that day ${eur(r.cost.day_margin)}` : "account layers only / day not closed"} />
      </div>
      <div className="card card-pad stack"><h3>Ownership chain</h3><Chain issue={i} chain={r.chain} /></div>
      <div className="card card-pad stack">
        <h3>Who held it, and for how long</h3>
        <table>
          <thead><tr><th>Level</th><th>Owner</th><th>From</th><th>To</th><th className="r">Time</th><th>How it got there</th></tr></thead>
          <tbody>{r.chain.map((s, k) => (
            <tr key={k}><td><LayerChip layer={s.layer} /></td><td>{s.owner_name}</td><td className="small">{when(s.entered_at)}</td><td className="small">{s.left_at ? when(s.left_at) : "now"}</td><td className="r num">{dur(s.minutes)}</td><td className="small">{s.how === "raised" ? "raised" : s.how === "auto" ? "automatic escalation" : "escalated by owner"}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {i.resolution && <div className="card card-pad"><h3 style={{ marginBottom: 6 }}>Resolution</h3>{i.resolution}</div>}
      <div className="card card-pad stack">
        <h3>Full timeline</h3>
        <div className="timeline">{r.events.map((e) => <div key={e.id} className="ev"><span className="faint num">{when(e.at)}</span><span>{eventText(e, names)}</span></div>)}</div>
      </div>
      <p className="faint small">Rates: agent cost €{r.campaign.hourly_cost}/h, billed €{r.campaign.billing_rate}/h. Generated {when(new Date().toISOString())}.</p>
    </div>
  );
}
