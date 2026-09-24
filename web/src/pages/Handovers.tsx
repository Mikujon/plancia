import { useState } from "react";
import { api, ago, useApi, type IssueRow } from "../api";
import { ErrorNote, LayerChip, SevChip, useApp } from "../components/ui";

export interface HandoverRow {
  id: string; team_id: string; team_name: string; campaign_id: string; date: string; shift_id: string; shift_name: string;
  author_id: string; author_name: string; notes: string; headcount_note: string | null;
  acknowledged_by: string | null; acknowledged_name: string | null; acknowledged_at: string | null; created_at: string;
  issues: { id: string; ref: string; title: string; status: string; layer: string; severity: string }[];
}

export function HandoverCard({ h }: { h: HandoverRow }) {
  const { me, openIssue } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const ack = async () => { try { await api(`/handovers/${h.id}/ack`, { method: "POST" }); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>{h.team_name} · {h.shift_name} handover</h2><div className="faint small">{h.author_name} · {ago(h.created_at)}</div></div>
        {h.acknowledged_at
          ? <span className="chip ok">read by {h.acknowledged_name}</span>
          : me.id !== h.author_id ? <button className="btn sm primary" onClick={ack}>Acknowledge</button> : <span className="chip warn">not read yet</span>}
      </div>
      <div className="card-pad stack">
        <div style={{ whiteSpace: "pre-wrap" }}>{h.notes}</div>
        {h.headcount_note && <div className="small"><b>Headcount:</b> {h.headcount_note}</div>}
        {h.issues.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <h3>Carried over ({h.issues.length})</h3>
            {h.issues.map((i) => (
              <a key={i.id} href="#" onClick={(e) => { e.preventDefault(); openIssue(i.id); }} className="row small">
                <span className="mono">{i.ref}</span><LayerChip layer={i.layer as never} /><SevChip s={i.severity} /><span>{i.title}</span>
                <span className="faint">{i.status.replace("_", " ")}</span>
              </a>
            ))}
          </div>
        )}
        <ErrorNote e={err} />
      </div>
    </div>
  );
}

export function Handovers() {
  const { org, me, teamIds } = useApp();
  const myTeams = org.teams.filter((t) => teamIds.has(t.id));
  const [teamId, setTeamId] = useState(org.teams.find((t) => t.tl_id === me.id)?.id ?? "");
  const list = useApi<HandoverRow[]>(`/handovers?limit=60${teamId ? `&team_id=${teamId}` : ""}`);
  return (
    <>
      <div className="page-head">
        <div><h1>Handovers</h1><p>What the next shift needs to know — open issues carry over automatically.</p></div>
        <select className="inline-select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">All my teams</option>
          {myTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div className="split">
        <div className="stack">
          {list.data?.length === 0 && <div className="card empty">No handovers yet.</div>}
          {list.data?.map((h) => <HandoverCard key={h.id} h={h} />)}
        </div>
        <NewHandover teamId={teamId || myTeams[0]?.id} />
      </div>
    </>
  );
}

function NewHandover({ teamId }: { teamId?: string }) {
  const { org, teamIds } = useApp();
  const [team, setTeam] = useState(teamId ?? "");
  const [shift, setShift] = useState(() => {
    const h = new Date().getUTCHours();
    return h >= 6 && h < 14 ? "s-morning" : h >= 14 && h < 22 ? "s-afternoon" : "s-night";
  });
  const [notes, setNotes] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = team || teamId || "";
  const open = useApi<IssueRow[]>(t ? `/issues?status=open&team_id=${t}` : null);
  const save = async () => {
    setErr(null);
    try {
      await api("/handovers", { method: "POST", body: { team_id: t, shift_id: shift, date: new Date().toISOString().slice(0, 10), notes, headcount_note: headcount || undefined } });
      setNotes(""); setHeadcount(""); setDone(true); setTimeout(() => setDone(false), 3000);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card" style={{ position: "sticky", top: 80 }}>
      <div className="card-head"><h2>Write handover</h2>{done && <span className="chip ok">saved</span>}</div>
      <div className="card-pad stack">
        <div className="grid g2">
          <label className="f">Team<select value={t} onChange={(e) => setTeam(e.target.value)}>
            {org.teams.filter((x) => teamIds.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
          <label className="f">Shift ending<select value={shift} onChange={(e) => setShift(e.target.value)}>
            {org.shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_hhmm}–{s.end_hhmm})</option>)}
          </select></label>
        </div>
        <label className="f">Notes for the next lead<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Queue state, who's out tomorrow, what to watch…" /></label>
        <label className="f">Headcount note<input value={headcount} onChange={(e) => setHeadcount(e.target.value)} placeholder="e.g. 18 planned, 2 sick confirmed" /></label>
        <div className="small muted">{open.data ? `${open.data.length} open issue${open.data.length === 1 ? "" : "s"} will carry over with their owners.` : ""}</div>
        <ErrorNote e={err} />
        <button className="btn primary" disabled={notes.trim().length < 3 || !t} onClick={save}>Hand over</button>
      </div>
    </div>
  );
}
