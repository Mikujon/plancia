import { useState } from "react";
import { Plus } from "lucide-react";
import { eur, useApi, type IssueRow, type Role } from "../api";
import { EscalationClock, NewIssueModal, SevChip, Tabs, useApp } from "../components/ui";

const LAYERS: Role[] = ["TL", "FM", "CSDM", "COO"];

/** One board per client campaign: columns are the layers, so ownership is the first thing you see. */
export function Board({ campaignId }: { campaignId?: string }) {
  const { org, campaignIds, openIssue } = useApp();
  const mine = org.campaigns.filter((c) => campaignIds.has(c.id));
  const id = campaignId && campaignIds.has(campaignId) ? campaignId : mine[0]?.id;
  const campaign = org.campaigns.find((c) => c.id === id);
  const client = org.clients.find((c) => c.id === campaign?.client_id);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [creating, setCreating] = useState(false);
  const { data } = useApi<IssueRow[]>(id ? `/issues?campaign_id=${id}&status=${status}${status === "resolved" ? "&limit=80" : ""}` : null, 30_000);
  const total = (data ?? []).reduce((s, i) => s + i.impact_amount, 0);

  if (!campaign) return <div className="card empty">No campaigns in your perimeter.</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            {mine.map((c) => (
              <a key={c.id} href={`#/board/${c.id}`} className={`chip ${c.id === id ? "TL" : ""}`} style={{ textDecoration: "none" }} aria-current={c.id === id ? "page" : undefined}>
                {org.clients.find((x) => x.id === c.client_id)?.name} · {c.name.split("·")[1]?.trim() ?? c.name}
              </a>
            ))}
          </div>
          <h1 className="row"><span className="dot" style={{ background: client?.color, width: 12, height: 12 }} />{campaign.name}</h1>
          <p>{data ? `${data.length} ${status} · ${eur(total)} cost logged` : "…"} · only this campaign's issues and costs appear here.</p>
        </div>
        <div className="row">
          <Tabs label="Status" value={status} onChange={setStatus} options={[["open", "Open"], ["resolved", "Resolved"]]} />
          <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />Log issue</button>
        </div>
      </div>
      <div className="board">
        {LAYERS.map((l) => {
          const col = (data ?? []).filter((i) => i.layer === l);
          return (
            <div className="col" key={l}>
              <div className="col-head"><span className="row"><span className={`chip ${l}`}>{l}</span><b className="small">{col.length}</b></span><span className="faint small num">{eur(col.reduce((s, i) => s + i.impact_amount, 0))}</span></div>
              <div className="col-body">
                {col.map((i) => (
                  <div key={i.id} className={`tile sev-${i.severity}`} onClick={() => openIssue(i.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openIssue(i.id)}>
                    <div className="row between"><span className="mono faint">{i.ref}</span><SevChip s={i.severity} /></div>
                    <div style={{ fontWeight: 500 }}>{i.title}</div>
                    <div className="row between small">
                      <span className="muted">{i.owner_name} · {i.team_name}</span>
                      {i.impact_amount > 0 && <span className="num" style={{ color: "var(--danger)" }}>{eur(i.impact_amount)}</span>}
                    </div>
                    <div className="row between small">
                      <span className={`chip ${i.status === "in_progress" ? "warn" : i.status === "open" ? "" : "ok"}`}>{i.status.replace("_", " ")}</span>
                      <EscalationClock i={i} />
                    </div>
                  </div>
                ))}
                {!col.length && <div className="faint small" style={{ padding: 8 }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {creating && <NewIssueModal onClose={() => setCreating(false)} teamId={org.teams.find((t) => t.campaign_id === id)?.id} />}
    </>
  );
}
