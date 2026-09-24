import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi, when, type DueSummary, type IssueRow } from "../api";
import { EscalationClock, Kpi, LayerChip, NewIssueModal, SevChip, Skeleton, SourceTag, StatusChip, Tabs, useApp, useSort } from "../components/ui";
import { DueChip } from "../components/kpi";

type View = "mine" | "overdue" | "today" | "week" | "open" | "closed";
const QUERY: Record<View, string> = {
  mine: "status=open&owner=me", overdue: "due=overdue", today: "due=today", week: "due=week",
  open: "status=open", closed: "status=resolved&limit=150",
};

/** Actions and issues, driven by due dates. */
export function Actions() {
  const { org, campaignIds, openIssue } = useApp();
  const [view, setView] = useState<View>("mine");
  const [campaign, setCampaign] = useState("");
  const [creating, setCreating] = useState(false);
  const due = useApi<DueSummary>("/actions/due", 60_000);
  const list = useApi<IssueRow[]>(`/issues?${QUERY[view]}${campaign ? `&campaign_id=${campaign}` : ""}`, 60_000);
  const { sorted, th } = useSort(list.data, { key: view === "closed" ? "resolved_at" : "due_at", dir: view === "closed" ? "desc" : "asc" });
  const d = due.data;

  return (
    <>
      <div className="page-head">
        <div><h1>Actions & due dates</h1><p>Every action has an owner and a due date. Not picked up in time, or not closed by its date, it moves one level up the reporting line.</p></div>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />New action</button>
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi label="Open" value={d?.open ?? "…"} sub={`${d?.not_picked_up ?? 0} not picked up yet`} />
        <Kpi label="Overdue" value={d?.overdue ?? "…"} sub={`${d?.due_today ?? 0} due today`} alert={(d?.overdue ?? 0) > 0} />
        <Kpi label="Due in 7 days" value={d?.due_week ?? "…"} />
        <Kpi label="Closed on time, 30 days" value={d?.on_time_pct != null ? `${d.on_time_pct}%` : "—"} sub={`${d?.closed_30d ?? 0} closed${d?.avg_days_late != null ? ` · late ones by ${d.avg_days_late} d` : ""}`} />
      </div>
      {d && d.by_manager.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Due-date discipline by direct report</h2></div>
          <table>
            <thead><tr><th>Who</th><th>Level</th><th className="r">Open</th><th className="r">Overdue</th><th className="r">Closed on time (30 d)</th></tr></thead>
            <tbody>{d.by_manager.map((m) => (
              <tr key={m.user_id}><td><b>{m.name}</b></td><td><LayerChip layer={m.role} /></td><td className="r num">{m.open}</td>
                <td className="r num">{m.overdue ? <span className="chip bad">{m.overdue}</span> : 0}</td><td className="r num">{m.on_time_pct != null ? `${m.on_time_pct}%` : "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <Tabs label="View" value={view} onChange={setView} options={[["mine", "Mine"], ["overdue", "Overdue"], ["today", "Due today"], ["week", "Due this week"], ["open", "All open"], ["closed", "Closed"]]} />
          <select className="inline-select" aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">All campaigns</option>
            {org.campaigns.filter((c) => campaignIds.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="table-wrap">
          {!sorted ? <Skeleton rows={6} /> : !sorted.length ? <div className="empty">Nothing here.</div> : (
            <table>
              <thead><tr>
                {th("ref", "Ref")}{th("title", "Action")}{th("owner_name", "Owner")}{th("team_name", "Team")}{th("kpi", "KPI")}
                {th("due_at", "Due")}{th("status", "Status")}<th>Next escalation</th>
              </tr></thead>
              <tbody>{sorted.map((i) => (
                <tr key={i.id} className="click" tabIndex={0} onClick={() => openIssue(i.id)} onKeyDown={(e) => e.key === "Enter" && openIssue(i.id)}>
                  <td className="mono">{i.ref}</td>
                  <td><div style={{ fontWeight: 500 }}>{i.title}</div><div className="row small">{<SevChip s={i.severity} />}{i.source !== "floor" && <SourceTag s={i.source} />}</div></td>
                  <td><LayerChip layer={i.layer} /> {i.owner_name}</td>
                  <td className="small">{i.team_name}<div className="faint">{i.campaign_name}</div></td>
                  <td className="small">{i.kpi ?? "—"}</td>
                  <td><DueChip i={i} /><div className="faint small">{when(i.due_at)}</div></td>
                  <td><StatusChip s={i.status} /></td>
                  <td><EscalationClock i={i} /></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
      {creating && <NewIssueModal onClose={() => setCreating(false)} />}
    </>
  );
}
