import { useState } from "react";
import { api, useApi } from "../api";
import { ErrorNote, LayerChip, Skeleton, SourceTag, useApp } from "../components/ui";

interface Integrations {
  groups: { id: string; source: string; external_id: string; name: string; team_id: string }[];
  wfm: string;
  api: { version: string; methods: Record<string, { method: string; path: string }>; limits: Record<string, number>; tokens_configured: number };
  webhooks: { telegram: { path: string; secret_configured: boolean }; google_chat: { path: string; token_configured: boolean } };
}

export function IntegrationsPage() {
  const { org, me } = useApp();
  const { data, reload } = useApi<Integrations>("/integrations");
  const [g, setG] = useState({ source: "telegram", external_id: "", name: "", team_id: org.teams[0]?.id ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const origin = window.location.origin;
  const add = async () => {
    setErr(null);
    try { await api("/chat/groups", { method: "POST", body: g }); setG({ ...g, external_id: "", name: "" }); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  if (!data) return <Skeleton rows={6} />;
  return (
    <>
      <div className="page-head"><div><h1>Integrations</h1><p>How Plancia connects: chat groups in, WFM/RTA in, and the ops.v1 API out to Nodo.</p></div></div>
      <div className="grid g2">
        <div className="card card-pad stack">
          <div className="row between"><h2>Nodo · ops.v1 API</h2><span className="chip ok">{data.api.version}</span></div>
          <p className="muted small" style={{ margin: 0 }}>Bearer-token API following Nodo's connector contract: version in the method name, opaque cursors, <code>observed_at</code> on every response, coded errors. {data.api.tokens_configured} token(s) configured.</p>
          <table>
            <tbody>{Object.entries(data.api.methods).map(([m, v]) => (
              <tr key={m}><td className="mono">{m}</td><td><span className="chip">{v.method}</span></td><td className="mono faint">{v.path}</td></tr>
            ))}</tbody>
          </table>
          <div className="small faint">Max page {data.api.limits.maxPageSize} · max range {data.api.limits.maxRangeDays} days · manifest at <span className="mono">{origin}/api/ops/v1/manifest</span></div>
        </div>
        <div className="card card-pad stack">
          <h2>Inbound</h2>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>Telegram bot webhook</b>{data.webhooks.telegram.secret_configured ? <span className="chip ok">secret set</span> : <span className="chip bad">no secret</span>}</div>
            <code className="mono small">{origin}{data.webhooks.telegram.path}</code>
            <span className="faint small">setWebhook with <code>secret_token</code>; add the bot to the team group; agents flag with <code>/issue</code>, #issue or 🚩.</span>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>Google Chat app endpoint</b>{data.webhooks.google_chat.token_configured ? <span className="chip ok">token set</span> : <span className="chip bad">no token</span>}</div>
            <code className="mono small">{origin}{data.webhooks.google_chat.path}?token=…</code>
            <span className="faint small">Configure as the Chat app's HTTP endpoint; add a <code>/issue</code> slash command.</span>
          </div>
          <div className="row between"><b>WFM / RTA staffing feed</b><span className={`chip ${data.wfm === "mock" ? "warn" : "ok"}`}>{data.wfm === "mock" ? "demo feed" : "live"}</span></div>
          <span className="faint small">Set <code>WFM_BASE_URL</code> to switch from the demo feed to the real one; only <code>server/adapters/wfm/traduzione.ts</code> changes when its shape is known.</span>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Chat groups mapped to teams</h2><span className="faint small">messages from unmapped groups are refused, so nothing lands without an owner</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Group</th><th>External id</th><th>Team</th></tr></thead>
            <tbody>{data.groups.map((x) => (
              <tr key={x.id}><td><SourceTag s={x.source} /></td><td>{x.name}</td><td className="mono small">{x.external_id}</td><td>{org.teams.find((t) => t.id === x.team_id)?.name}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {me.role !== "TL" && (
          <div className="card-pad stack" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="grid g4">
              <label className="f">Source<select value={g.source} onChange={(e) => setG({ ...g, source: e.target.value })}><option value="telegram">Telegram</option><option value="google_chat">Google Chat</option></select></label>
              <label className="f">External id<input value={g.external_id} onChange={(e) => setG({ ...g, external_id: e.target.value })} placeholder={g.source === "telegram" ? "-100…" : "spaces/…"} /></label>
              <label className="f">Name<input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} /></label>
              <label className="f">Team<select value={g.team_id} onChange={(e) => setG({ ...g, team_id: e.target.value })}>{org.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            </div>
            <div><button className="btn" disabled={!g.external_id || !g.name} onClick={add}>Map group</button></div>
            <ErrorNote e={err} />
          </div>
        )}
      </div>
    </>
  );
}
