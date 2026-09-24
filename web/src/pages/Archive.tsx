import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, dur, eur, useApi, when, type IssueRow } from "../api";
import { LayerChip, SevChip, Skeleton, StatusChip, Tabs, useApp, useSort } from "../components/ui";
import { Search } from "lucide-react";
import type { HandoverRow } from "./Handovers";

interface Patterns {
  from: string;
  weekly: { week: string; category: string; cost: number; n: number }[];
  by_team: { team_id: string; team_name: string; cost: number; n: number; avg_resolve_min: number | null }[];
  by_weekday: { weekday: number; category: string; n: number; cost: number }[];
}

const CAT_COLOR: Record<string, string> = {
  staffing: "#2f7fb3", system: "#8a5cc9", sla: "#c2382b", client: "#d08a1f", quality: "#2b9a6a", hr: "#7b8a84", other: "#a3aca6",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function Archive() {
  const { org, campaignIds, openIssue } = useApp();
  const [q, setQ] = useState("");
  const [campaign, setCampaign] = useState("");
  const [category, setCategory] = useState("");
  const [what, setWhat] = useState<"issues" | "handovers">("issues");
  const dq = useDebounced(q);
  const params = new URLSearchParams({ status: "all", limit: "150" });
  if (dq) params.set("q", dq);
  if (campaign) params.set("campaign_id", campaign);
  if (category) params.set("category", category);
  const issues = useApi<IssueRow[]>(what === "issues" ? `/issues?${params}` : null);
  const handovers = useApi<HandoverRow[]>(what === "handovers" ? `/handovers?limit=150${dq ? `&q=${encodeURIComponent(dq)}` : ""}` : null);
  const pat = useApi<Patterns>(`/patterns?weeks=8${campaign ? `&campaign_id=${campaign}` : ""}`);
  const found = issues.data ?? [];
  const cost = found.reduce((s, i) => s + i.impact_amount, 0);
  const withTime = useMemo(() => issues.data?.map((i) => ({
    ...i, resolve_min: i.resolved_at ? (Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 60000 : null,
  })) ?? null, [issues.data]);
  const { sorted, th } = useSort(withTime, { key: "created_at", dir: "desc" });

  return (
    <>
      <div className="page-head"><div><h1>Archive & patterns</h1><p>Every past issue and handover, searchable, with the cost history to spot what keeps coming back.</p></div></div>
      {pat.data && <PatternsView p={pat.data} />}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ flexWrap: "wrap" }}>
          <Tabs label="Search in" value={what} onChange={setWhat} options={[["issues", "Issues"], ["handovers", "Handovers"]]} />
          <div className="row" style={{ flex: 1, justifyContent: "flex-end" }}>
            <div className="search" style={{ width: 280, maxWidth: "100%" }}><Search size={16} aria-hidden /><input aria-label="Search the archive" placeholder="Search title, notes, resolution, ref…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {what === "issues" && <>
              <select className="inline-select" aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">All campaigns</option>
                {org.campaigns.filter((c) => campaignIds.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className="inline-select" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </>}
          </div>
        </div>
        {what === "issues" && (
          <div className="table-wrap">
            <div className="card-pad small muted" aria-live="polite">{issues.data ? `${found.length} issues${found.length === 150 ? " (first 150)" : ""} · ${eur(cost)} total cost` : ""}</div>
            {!issues.data ? <Skeleton rows={6} /> : (
            <table>
              <thead><tr>{th("ref", "Ref")}{th("title", "Issue")}{th("campaign_name", "Campaign")}{th("layer", "Layer reached")}{th("status", "Status")}{th("impact_amount", "Cost", true)}{th("resolve_min", "Time to resolve", true)}{th("created_at", "Raised")}</tr></thead>
              <tbody>
                {(sorted ?? []).map((i) => (
                  <tr key={i.id} className="click" tabIndex={0} onClick={() => openIssue(i.id)} onKeyDown={(e) => e.key === "Enter" && openIssue(i.id)}>
                    <td className="mono">{i.ref}</td>
                    <td><div style={{ fontWeight: 500 }}>{i.title}</div>{i.resolution && <div className="faint small">{i.resolution}</div>}</td>
                    <td className="small">{i.campaign_name}<div className="faint">{i.team_name}</div></td>
                    <td><LayerChip layer={i.layer} /> <SevChip s={i.severity} /></td>
                    <td><StatusChip s={i.status} /></td>
                    <td className="r num">{i.impact_amount ? eur(i.impact_amount) : "—"}</td>
                    <td className="r num">{i.resolve_min != null ? dur(i.resolve_min) : "—"}</td>
                    <td className="small faint">{when(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        )}
        {what === "handovers" && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Team</th><th>Author</th><th>Notes</th><th className="r">Carried</th><th>Read</th></tr></thead>
              <tbody>
                {(handovers.data ?? []).map((h) => (
                  <tr key={h.id}>
                    <td className="small faint">{when(h.created_at)}<div>{h.shift_name}</div></td>
                    <td>{h.team_name}</td><td>{h.author_name}</td>
                    <td className="small" style={{ maxWidth: 480 }}>{h.notes}</td>
                    <td className="r num">{h.issues.length}</td>
                    <td>{h.acknowledged_at ? <span className="chip ok">{h.acknowledged_name}</span> : <span className="chip warn">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function PatternsView({ p }: { p: Patterns }) {
  const weeks = [...new Set(p.weekly.map((w) => w.week))].sort();
  const cats = [...new Set(p.weekly.map((w) => w.category))];
  const weekTotals = weeks.map((wk) => p.weekly.filter((w) => w.week === wk).reduce((s, w) => s + w.cost, 0));
  const max = Math.max(1, ...weekTotals);
  const H = 150;
  // weekday × category counts, to surface things like "Monday no-shows"
  const heat = new Map(p.by_weekday.map((x) => [`${x.weekday}|${x.category}`, x.n]));
  const heatMax = Math.max(1, ...p.by_weekday.map((x) => x.n));
  const topCats = [...cats].sort((a, b) =>
    p.by_weekday.filter((x) => x.category === b).reduce((s, x) => s + x.n, 0) - p.by_weekday.filter((x) => x.category === a).reduce((s, x) => s + x.n, 0));
  return (
    <div className="grid g2">
      <div className="card card-pad stack">
        <div className="row between"><h3>Cost by week and category</h3><span className="faint small">since {p.from}</span></div>
        <svg viewBox={`0 0 ${weeks.length * 40} ${H + 18}`} style={{ width: "100%", height: H + 18 }} role="img" aria-label="Weekly issue cost by category">
          {weeks.map((wk, i) => {
            let y = H;
            return (
              <g key={wk}>
                {cats.map((c) => {
                  const v = p.weekly.find((w) => w.week === wk && w.category === c)?.cost ?? 0;
                  const h = (v / max) * (H - 6);
                  y -= h;
                  return v ? <rect key={c} x={i * 40 + 8} y={y} width={24} height={Math.max(h - 1, 0)} fill={CAT_COLOR[c]} rx={2}><title>{`${wk} · ${c}: ${eur(v)}`}</title></rect> : null;
                })}
                <text x={i * 40 + 20} y={H + 14} fontSize="9" textAnchor="middle" fill="var(--text-3)">{wk.slice(5)}</text>
              </g>
            );
          })}
        </svg>
        <div className="row small">{cats.map((c) => <span key={c} className="row" style={{ gap: 4 }}><span className="dot" style={{ background: CAT_COLOR[c] }} />{c}</span>)}</div>
      </div>
      <div className="card card-pad stack">
        <h3>When do issues happen?</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th></th>{DAYS.map((d) => <th key={d} className="r">{d}</th>)}</tr></thead>
            <tbody>
              {topCats.slice(0, 6).map((c) => (
                <tr key={c}>
                  <td className="small"><span className="dot" style={{ background: CAT_COLOR[c] }} /> {c}</td>
                  {DAYS.map((_, d) => {
                    const n = heat.get(`${d}|${c}`) ?? 0;
                    return <td key={d} className="r num small" style={{ background: n ? `color-mix(in srgb, ${CAT_COLOR[c]} ${Math.round((n / heatMax) * 70)}%, transparent)` : undefined, color: n / heatMax > 0.5 ? "#fff" : undefined }}>{n || ""}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Costliest teams</h3>
        <table>
          <tbody>{p.by_team.slice(0, 5).map((t) => (
            <tr key={t.team_id}><td>{t.team_name}</td><td className="r num small">{t.n} issues</td><td className="r num small">avg {dur(t.avg_resolve_min)}</td><td className="r num"><b>{eur(t.cost)}</b></td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
