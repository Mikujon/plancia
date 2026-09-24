import { useState } from "react";
import { ArrowRight, Flag, ListPlus } from "lucide-react";
import { api, ago, useApi } from "../api";
import { ErrorNote, Skeleton, SourceTag, Tabs, useApp } from "../components/ui";

interface Msg {
  id: string; group_id: string; group_name: string; source: "telegram" | "google_chat"; team_id: string; team_name: string;
  author: string; text: string; sent_at: string; flagged: number; dismissed: number; issue_id: string | null; issue_ref: string | null;
}

const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/** Flagged chat messages become tracked issues in one click — owner and layer set automatically. */
export function Inbox() {
  const { openIssue } = useApp();
  const [view, setView] = useState<"flagged" | "all">("flagged");
  const { data, reload } = useApi<Msg[]>(`/inbox?view=${view}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const track = async (m: Msg) => {
    setBusy(m.id); setErr(null);
    try { const i = await api<{ id: string }>(`/inbox/${m.id}/issue`, { method: "POST", body: {} }); openIssue(i.id); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); reload(); }
  };
  const patch = async (m: Msg, body: object) => { await api(`/inbox/${m.id}`, { method: "PATCH", body }); reload(); };

  return (
    <>
      <div className="page-head">
        <div><h1>Chat inbox</h1><p>Messages flagged in your teams' Google Chat and Telegram groups (#issue, 🚩, URGENT, or /issue). One click makes it a tracked issue.</p></div>
        <Tabs label="Messages" value={view} onChange={setView} options={[["flagged", "Flagged, not tracked"], ["all", "All messages (48 h)"]]} />
      </div>
      <ErrorNote e={err} />
      <div>
        <div className="card">
          {!data && <Skeleton />}
          {data?.length === 0 && <div className="empty">{view === "flagged" ? "Nothing flagged is waiting — everything is tracked or dismissed." : "No messages in the last 48 hours."}</div>}
          {data?.map((m) => (
            <div key={m.id} className="msg">
              <div className="avatar">{initials(m.author)}</div>
              <div className="stack" style={{ gap: 4 }}>
                <div className="row small"><b>{m.author}</b><SourceTag s={m.source} /><span className="muted">{m.group_name}</span><span className="faint">{ago(m.sent_at)}</span></div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                {m.issue_id
                  ? <button className="btn sm" onClick={() => openIssue(m.issue_id!)}>{m.issue_ref}<ArrowRight size={14} aria-hidden /></button>
                  : <>
                      <button className="btn sm primary" disabled={busy === m.id} onClick={() => track(m)}><ListPlus size={16} aria-hidden />Track as issue</button>
                      {m.flagged === 1 && m.dismissed === 0 ? <button className="btn sm ghost" onClick={() => patch(m, { dismissed: true })} title="Not an issue">Dismiss</button>
                        : !m.flagged ? <button className="btn sm ghost" onClick={() => patch(m, { flagged: true, dismissed: false })}><Flag size={14} aria-hidden />Flag</button> : null}
                    </>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
