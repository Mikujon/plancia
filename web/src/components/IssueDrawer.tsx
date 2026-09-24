import { useEffect, useState } from "react";
import { ArrowRight, FileText, X } from "lucide-react";
import { api, dueText, dur, eur, IMPACT_NAME, when, type ChainStep, type EventRow, type IssueRow, type Role, useApi, ROLE_NAME } from "../api";
import { EscalationClock, ErrorNote, ImpactFields, LayerChip, Modal, SevChip, Skeleton, StatusChip, useApp } from "./ui";

const RANK: Record<Role, number> = { TL: 0, FM: 1, CSDM: 2, COO: 3 };

/** Strict reporting line: always the owner's manager, one level up. */
function nextLayer(_i: IssueRow, layer: Role): Role | null {
  return layer === "TL" ? "FM" : layer === "FM" ? "CSDM" : layer === "CSDM" ? "COO" : null;
}

export function Chain({ issue, chain }: { issue: IssueRow; chain: ChainStep[] }) {
  const open = issue.status === "open" || issue.status === "in_progress";
  const future: Role[] = [];
  if (open) for (let l = nextLayer(issue, issue.layer); l; l = nextLayer(issue, l)) future.push(l);
  const end = issue.resolved_at ?? new Date().toISOString();
  return (
    <div className="chain">
      {chain.map((s, k) => {
        const current = open && k === chain.length - 1;
        const mins = s.minutes ?? (Date.parse(s.left_at ?? end) - Date.parse(s.entered_at)) / 60_000;
        return (
          <div key={k} className={`step ${current ? "now" : ""}`}>
            <div className="row between"><LayerChip layer={s.layer} /><span className="faint small">{s.how === "raised" ? "raised" : s.how === "auto" ? "auto-escalated" : "escalated"}</span></div>
            <div className="who">{s.owner_name}</div>
            <div className="faint small">{current ? `owns it now · ${dur(mins)}` : dur(mins)}</div>
          </div>
        );
      })}
      {future.map((l) => (
        <div key={l} className="step future"><LayerChip layer={l} /><div className="who faint">{ROLE_NAME[l]}</div><div className="faint small">next if unresolved</div></div>
      ))}
      {!open && <div className="step done"><span className="chip ok">resolved</span><div className="who">{when(issue.resolved_at!)}</div><div className="faint small">total {dur((Date.parse(issue.resolved_at!) - Date.parse(issue.created_at)) / 60000)}</div></div>}
    </div>
  );
}

export function eventText(e: EventRow, names: Map<string, string>) {
  const who = e.actor_name ?? "System";
  switch (e.type) {
    case "created": return <><b>{who}</b> raised it{e.note && e.note !== "floor" ? ` from ${e.note.replace("_", " ")}` : " on the floor"} at <LayerChip layer={e.to_value as Role} /></>;
    case "assigned": return <>Owner → <b>{names.get(e.to_value ?? "") ?? e.to_value}</b></>;
    case "escalated": return <><b>{e.actor_name ?? "Auto-escalation"}</b> moved it <LayerChip layer={e.from_value as Role} /> → <LayerChip layer={e.to_value as Role} />{e.note && <span className="muted"> — {e.note}</span>}</>;
    case "status": return <><b>{who}</b> set status to {e.to_value?.replace("_", " ")}</>;
    case "cost": return <><b>{who}</b> set cost impact {e.from_value ? `${eur(Number(e.from_value))} → ` : ""}<b>{eur(Number(e.to_value))}</b> <span className="muted">({e.note})</span></>;
    case "resolved": return <><b>{who}</b> resolved it: <span className="muted">{e.note}</span></>;
    case "reopened": return <><b>{who}</b> reopened it: <span className="muted">{e.note}</span></>;
    case "comment": return <><b>{who}</b>: {e.note}</>;
    case "due": return <><b>{e.actor_name ?? "System"}</b> {e.from_value ? "moved the due date" : "set the due date"} to <b>{when(e.to_value!)}</b>{e.note && <span className="muted"> — {e.note}</span>}</>;
    default: return <>{e.type}</>;
  }
}

export function IssueDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { org, me } = useApp();
  const { data, error, reload } = useApi<{ issue: IssueRow; events: EventRow[]; chain: ChainStep[] }>(`/issues/${id}`, 30_000);
  const [modal, setModal] = useState<null | "escalate" | "resolve" | "reopen" | "cost" | "due">(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const names = new Map(org.users.map((u) => [u.id, u.name]));

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !modal && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, modal]);

  const act = async (path: string, body: unknown, method = "POST") => {
    setErr(null);
    try { await api(`/issues/${id}${path}`, { method, body }); setModal(null); setText(""); reload(); }
    catch (e) { setErr((e as Error).message); }
  };

  const i = data?.issue;
  const open = i && (i.status === "open" || i.status === "in_progress");
  const canAct = i && (me.id === i.owner_id || RANK[me.role] >= RANK[i.layer]);
  const next = i ? nextLayer(i, i.layer) : null;
  const campaign = i && org.campaigns.find((c) => c.id === i.campaign_id);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={i ? `${i.ref} ${i.title}` : "Issue"}>
        <div className="drawer-head">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row"><span className="mono faint">{i?.ref}</span>{i && <><SevChip s={i.severity} /><StatusChip s={i.status} /><span className="chip">{i.category}</span>{i.sla_related ? <span className="chip warn">client / SLA</span> : null}{i.kpi && <span className="chip">KPI · {i.kpi}</span>}</>}</div>
            <h2 style={{ fontSize: 18 }}>{i?.title ?? "Loading…"}</h2>
            {i && <div className="muted small">{i.campaign_name} · {i.team_name} · raised {when(i.created_at)}</div>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close issue"><X size={18} /></button>
        </div>
        {error && <div className="drawer-body"><ErrorNote e={error} /></div>}
        {!data && !error && <Skeleton rows={6} />}
        {i && data && (
          <div className="drawer-body">
            <section className="card card-pad stack">
              <div className="row between"><h3>Who owns it now</h3><EscalationClock i={i} /></div>
              <div className="row small">
                <span className={`chip ${i.due_state === "overdue" || i.due_state === "done_late" ? "bad" : i.due_state === "due_soon" ? "warn" : i.due_state === "done" ? "ok" : ""}`}>{dueText(i)}</span>
                <span className="muted">due {when(i.due_at)}</span>
                {!i.acknowledged_at && open && <span className="chip warn">not picked up yet</span>}
                {canAct && open && <button className="btn sm ghost" onClick={() => setModal("due")}>Change due date</button>}
              </div>
              <Chain issue={i} chain={data.chain} />
              {open && (
                <div className="row">
                  {canAct && i.status === "open" && <button className="btn" onClick={() => act("", { status: "in_progress" }, "PATCH")}>Take it</button>}
                  {canAct && <button className="btn primary" onClick={() => setModal("resolve")}>Resolve</button>}
                  {canAct && next && <button className="btn" onClick={() => setModal("escalate")}>Can't resolve<ArrowRight size={16} aria-hidden />{next}</button>}
                  {canAct && (
                    <select className="inline-select" title="Reassign within the layer" value={i.owner_id} onChange={(e) => act("", { owner_id: e.target.value }, "PATCH")} aria-label="Reassign">
                      {org.users.filter((u) => u.role === i.layer).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  )}
                  {!canAct && <span className="faint small">Sits with the {i.layer} layer — you can follow and comment.</span>}
                </div>
              )}
              {!open && <div className="row">{i.resolution && <span><b>Resolution:</b> {i.resolution}</span>}<button className="btn sm" onClick={() => setModal("reopen")}>Reopen</button></div>}
              <ErrorNote e={err && !modal ? err : null} />
            </section>

            <section className="card card-pad stack">
              <div className="row between">
                <h3>Cost / margin impact</h3>
                {canAct && <button className="btn sm" onClick={() => setModal("cost")}>Update</button>}
              </div>
              <div className="grid g3">
                <div><div className="faint small">Type</div><b>{IMPACT_NAME[i.impact_type]}</b></div>
                <div><div className="faint small">Hours</div><b className="num">{i.impact_hours || "—"}</b></div>
                <div><div className="faint small">Margin effect</div><b className="num" style={{ color: i.impact_amount ? "var(--danger)" : undefined }}>{i.impact_amount ? `−${eur(i.impact_amount)}` : "—"}</b></div>
              </div>
              {campaign && <div className="faint small">Rates for {campaign.name}: agent cost €{campaign.hourly_cost}/h · billed €{campaign.billing_rate}/h · SLA target {campaign.sla_target_pct}%</div>}
            </section>

            {i.description && <section className="card card-pad"><h3 style={{ marginBottom: 8 }}>Details</h3><div style={{ whiteSpace: "pre-wrap" }}>{i.description}</div></section>}

            <section className="card card-pad stack">
              <div className="row between"><h3>Timeline</h3><a className="btn sm" href={`#/report/${i.id}`} onClick={onClose}><FileText size={16} aria-hidden />End-to-end report</a></div>
              <div className="timeline">
                {data.events.map((e) => (
                  <div key={e.id} className="ev"><span className="faint num">{when(e.at)}</span><span>{eventText(e, names)}</span></div>
                ))}
              </div>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input aria-label="Add a note" placeholder="Add a note for whoever picks this up…" value={modal ? "" : text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && text.trim() && act("/comments", { text })} />
                <button className="btn" disabled={!text.trim()} onClick={() => act("/comments", { text })}>Add</button>
              </div>
            </section>
          </div>
        )}
      </aside>

      {modal === "escalate" && i && (
        <Modal title={`Escalate to ${next}`} onClose={() => setModal(null)}
          foot={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" disabled={text.trim().length < 3} onClick={() => act("/escalate", { reason: text })}>Escalate</button></>}>
          <p className="muted" style={{ margin: 0 }}>It moves to the {next ? ROLE_NAME[next] : ""} for {i.team_name}, and they become the owner.</p>
          <label className="f">Why can't it be resolved at {i.layer}?<textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>
          <ErrorNote e={err} />
        </Modal>
      )}
      {modal === "resolve" && i && <ResolveModal i={i} onClose={() => setModal(null)} onDone={(b) => act("/resolve", b)} err={err} />}
      {modal === "cost" && i && <CostModal i={i} onClose={() => setModal(null)} onDone={(b) => act("", b, "PATCH")} err={err} />}
      {modal === "due" && i && <DueModal i={i} onClose={() => setModal(null)} onDone={(b) => act("", b, "PATCH")} err={err} />}
      {modal === "reopen" && (
        <Modal title="Reopen issue" onClose={() => setModal(null)}
          foot={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" disabled={text.trim().length < 3} onClick={() => act("/reopen", { note: text })}>Reopen</button></>}>
          <label className="f">What came back?<textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>
          <ErrorNote e={err} />
        </Modal>
      )}
    </div>
  );
}

function ResolveModal({ i, onClose, onDone, err }: { i: IssueRow; onClose: () => void; onDone: (b: unknown) => void; err: string | null }) {
  const [f, setF] = useState({ resolution: "", impact_type: i.impact_type, impact_hours: i.impact_hours, impact_amount: i.impact_type === "sla_penalty" || i.impact_type === "other" ? i.impact_amount : null as number | null });
  return (
    <Modal title="Resolve" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={f.resolution.trim().length < 3} onClick={() => onDone(f)}>Resolve</button></>}>
      <label className="f">How was it resolved?<textarea autoFocus value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} /></label>
      <div className="faint small">Confirm the final cost — this is what the margin reports use.</div>
      <ImpactFields v={f} set={(p) => setF({ ...f, ...p })} campaignId={i.campaign_id} />
      <ErrorNote e={err} />
    </Modal>
  );
}

function CostModal({ i, onClose, onDone, err }: { i: IssueRow; onClose: () => void; onDone: (b: unknown) => void; err: string | null }) {
  const [f, setF] = useState({ impact_type: i.impact_type, impact_hours: i.impact_hours, impact_amount: i.impact_type === "sla_penalty" || i.impact_type === "other" ? i.impact_amount : null as number | null });
  return (
    <Modal title="Cost / margin impact" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onDone(f)}>Save</button></>}>
      <ImpactFields v={f} set={(p) => setF({ ...f, ...p })} campaignId={i.campaign_id} />
      <ErrorNote e={err} />
    </Modal>
  );
}

function DueModal({ i, onClose, onDone, err }: { i: IssueRow; onClose: () => void; onDone: (b: unknown) => void; err: string | null }) {
  const toLocal = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const [due, setDue] = useState(toLocal(i.due_at));
  const [reason, setReason] = useState("");
  const later = new Date(due).toISOString() > i.due_at;
  return (
    <Modal title="Change due date" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={later && reason.trim().length < 3} onClick={() => onDone({ due_at: new Date(due).toISOString(), due_reason: reason || undefined })}>Save</button></>}>
      <label className="f">New due date<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <label className="f">Reason{later ? " (required when pushing it out)" : ""}<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. waiting for the client's calibration session" /></label>
      <p className="faint small" style={{ margin: 0 }}>The change and the reason go on the timeline; the end-to-end report counts due-date changes.</p>
      <ErrorNote e={err} />
    </Modal>
  );
}
