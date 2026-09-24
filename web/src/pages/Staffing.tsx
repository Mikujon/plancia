import { useState } from "react";
import { Pencil } from "lucide-react";
import { api, ago, eur, useApi } from "../api";
import { ErrorNote, Kpi, Modal, Skeleton, useApp } from "../components/ui";

export interface StaffingRow {
  team_id: string; team_name: string; floor_id: string; floor_name: string; tl_name: string;
  campaign_id: string; campaign_name: string; client_id: string; shift_id: string; shift_name: string; date: string; hours_left: number;
  required: number; scheduled: number; present: number; gap: number; gap_pct: number; gap_cost: number; at_risk: boolean;
  source: "rta" | "manual"; observed_at: string;
}

export function StaffingTable({ rows, compact }: { rows: StaffingRow[] | null; compact?: boolean }) {
  const [edit, setEdit] = useState<StaffingRow | null>(null);
  if (!rows) return <Skeleton />;
  if (!rows.length) return <div className="empty">No shift running for these teams right now.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>
          <th>Team</th>{!compact && <th>Campaign</th>}{!compact && <th>Shift</th>}<th className="r">{compact ? "Present" : "Present / req."}</th>{!compact && <th style={{ width: 110 }}></th>}<th className="r">Gap</th><th className="r">{compact ? "Cost" : "Cost of gap"}</th><th><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.team_id}-${r.shift_id}`}>
              <td><b>{r.team_name}</b><div className="faint small">{compact ? `${r.shift_name} · ${r.hours_left} h left` : `${r.floor_name} · ${r.tl_name}`}</div></td>
              {!compact && <td className="small">{r.campaign_name}</td>}
              {!compact && <td className="small">{r.shift_name}<div className="faint">{r.hours_left} h left</div></td>}
              <td className="r num">{r.present} / {r.required}{!compact && <div className="faint small">{r.scheduled} scheduled</div>}</td>
              {!compact && <td><div className={`bar ${r.gap_pct >= 15 ? "bad" : r.gap_pct >= 10 ? "warn" : ""}`}><span style={{ width: `${Math.min(100, (r.present / Math.max(1, r.required)) * 100)}%` }} /></div></td>}
              <td className="r num">{r.gap ? <span className={`chip ${r.at_risk ? "bad" : "warn"}`}>−{r.gap} · {r.gap_pct}%</span> : <span className="chip ok">full</span>}</td>
              <td className="r num">{r.gap_cost ? eur(r.gap_cost) : "—"}</td>
              <td className="r">
                <button className="btn ghost sm" aria-label={`Correct headcount for ${r.team_name}`} title={`${r.source === "manual" ? "Corrected by hand" : "RTA feed"} · ${ago(r.observed_at)}`} onClick={() => setEdit(r)}>
                  <Pencil size={14} aria-hidden />{compact ? "" : r.source === "manual" ? "manual" : "correct"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <CorrectModal r={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CorrectModal({ r, onClose }: { r: StaffingRow; onClose: () => void }) {
  const [present, setPresent] = useState(r.present);
  const [scheduled, setScheduled] = useState(r.scheduled);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try { await api("/staffing/manual", { method: "POST", body: { team_id: r.team_id, shift_id: r.shift_id, date: r.date, present, scheduled } }); onClose(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={`Correct headcount — ${r.team_name}`} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted" style={{ margin: 0 }}>Overrides the RTA feed for 30 minutes. Required for this shift: <b>{r.required}</b>.</p>
      <div className="grid g2">
        <label className="f">Scheduled<input type="number" min={0} value={scheduled} onChange={(e) => setScheduled(Number(e.target.value))} /></label>
        <label className="f">Present now<input type="number" min={0} value={present} onChange={(e) => setPresent(Number(e.target.value))} /></label>
      </div>
      <ErrorNote e={err} />
    </Modal>
  );
}

export function Staffing() {
  const { org } = useApp();
  const [campaign, setCampaign] = useState("");
  const { data } = useApi<StaffingRow[]>(`/staffing${campaign ? `?campaign_id=${campaign}` : ""}`, 60_000);
  const rows = data ?? [];
  const byCampaign = new Map<string, { name: string; req: number; present: number; cost: number }>();
  for (const r of rows) {
    const c = byCampaign.get(r.campaign_id) ?? { name: r.campaign_name, req: 0, present: 0, cost: 0 };
    c.req += r.required; c.present += r.present; c.cost += r.gap_cost; byCampaign.set(r.campaign_id, c);
  }
  const campaigns = org.campaigns.filter((c) => rows.some((r) => r.campaign_id === c.id) || c.id === campaign);
  return (
    <>
      <div className="page-head">
        <div><h1>Staffing now</h1><p>Live headcount per campaign and shift from the {org.wfm === "mock" ? "RTA feed (demo feed)" : "RTA/WFM feed"}, with the cost of every gap.</p></div>
        <select className="inline-select" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">All campaigns</option>
          {(campaign ? org.campaigns : campaigns).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        {[...byCampaign.entries()].map(([id, c]) => (
          <Kpi key={id} label={c.name} value={`${c.present}/${c.req}`} sub={c.cost ? `${eur(c.cost)} at risk this shift` : "fully staffed"} alert={c.req - c.present > c.req * 0.1} />
        ))}
      </div>
      <div className="card"><StaffingTable rows={data} /></div>
      <p className="faint small">A gap of 15% or more (at least 2 heads) opens a tracked staffing issue on its own, owned by the team's TL.</p>
    </>
  );
}
