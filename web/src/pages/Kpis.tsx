import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtKpi, useApi, type Rag, type ScoreNode } from "../api";
import { LayerChip, Skeleton, Tabs } from "../components/ui";
import { KpiCell, PeriodPicker, RagChip, TrendChart, useKpiDefs } from "../components/kpi";

const GROUPS = ["Headline", "Service", "Efficiency", "Workforce", "Quality", "Finance"] as const;
const HEADLINE = ["sl", "abandon", "aht", "adherence", "absenteeism", "qa", "csat", "margin"];

function flatten(n: ScoreNode, depth = 0, out: { n: ScoreNode; depth: number }[] = []) {
  out.push({ n, depth });
  n.children.forEach((c) => flatten(c, depth + 1, out));
  return out;
}

/**
 * The scorecard down the reporting line: COO → CSDM accounts → Floor Managers → Team Leaders.
 * Every row is computed from raw counts of the teams below it (ratio of sums), against targets
 * weighted by each campaign's own volume.
 */
export function Kpis({ nodeParam, kpiParam }: { nodeParam?: string; kpiParam?: string }) {
  const [days, setDays] = useState("30");
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("Headline");
  const defs = useKpiDefs();
  const tree = useApi<ScoreNode>(`/kpis/scorecard?days=${days}`);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(nodeParam ?? null);
  const [kpi, setKpi] = useState(kpiParam ?? "sl");
  const grain = days === "90" ? "week" : "day";

  const rows = useMemo(() => (tree.data ? flatten(tree.data) : []), [tree.data]);
  const root = tree.data;
  // arriving from the overview with a node: open the branches down to it
  useEffect(() => {
    if (!root || !nodeParam) return;
    setOpen((o) => new Set([...o, ...pathTo(root, nodeParam)]));
  }, [root, nodeParam]);
  const selected = rows.find((r) => r.n.id === (sel ?? root?.id))?.n ?? root;
  const trend = useApi<{ period: string; value: number | null; target: number; rag: Rag }[]>(
    selected ? `/kpis/trend?days=${days}&kpi=${kpi}&node=${selected.id}&grain=${grain}` : null);

  const codes = [...defs.values()].filter((d) => (group === "Headline" ? HEADLINE.includes(d.code) : d.group === group)).map((d) => d.code);
  // collapsed by default below the viewer's direct reports; the selected node's path stays open
  const visible = rows.filter(({ n, depth }) => {
    if (depth <= 1) return true;
    const path = pathTo(root!, n.id);
    return path.slice(0, -1).every((p, i) => i === 0 || open.has(p));
  });
  const toggle = (id: string) => setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const def = defs.get(kpi);
  const k = selected?.kpis[kpi];

  return (
    <>
      <div className="page-head">
        <div><h1>KPI scorecard</h1><p>Along the reporting line, against contract targets. Green on target, amber inside the tolerance band, red outside it.</p></div>
        <PeriodPicker value={days} onChange={setDays} />
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <Tabs label="KPI group" value={group} onChange={setGroup} options={GROUPS.filter((g) => g !== "Finance" || defs.has("margin")).map((g) => [g, g])} />
          <span className="faint small">Click a row for its trend · click a value to chart that KPI</span>
        </div>
        <div className="table-wrap">
          {!root ? <Skeleton rows={6} /> : (
            <table className="tree">
              <thead><tr>
                <th>Hierarchy</th><th className="r">Volume</th>
                {codes.map((c) => <th key={c} className="r" title={`${defs.get(c)!.formula}`}>{defs.get(c)!.name}<div className="faint" style={{ textTransform: "none", fontWeight: 400 }}>target {fmtKpi(defs.get(c)!.unit, root.kpis[c]?.target)}</div></th>)}
              </tr></thead>
              <tbody>
                {visible.map(({ n, depth }) => (
                  <tr key={n.id} className={`click ${selected?.id === n.id ? "sel" : ""}`} onClick={() => setSel(n.id)}>
                    <td>
                      <span className="lvl" style={{ paddingLeft: depth * 18 }}>
                        {n.children.length > 0 && depth >= 1
                          ? <button className="toggle" aria-label={open.has(n.id) ? "Collapse" : "Expand"} aria-expanded={open.has(n.id)} onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>
                              {open.has(n.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          : <span style={{ width: 18 }} />}
                        {n.level !== "TEAM" && <LayerChip layer={n.level} />}
                        <span><b>{n.label}</b><div className="faint small">{n.name}</div></span>
                      </span>
                    </td>
                    <td className="r num">{n.volume.toLocaleString("en-GB")}</td>
                    {codes.map((c) => (
                      <td key={c} className="r" onClick={() => setKpi(c)}><KpiCell def={defs.get(c)!} k={n.kpis[c]} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {selected && def && (
        <div className="card">
          <div className="card-head">
            <div className="row"><h2>{def.name} · {selected.label}</h2>{k && <RagChip rag={k.rag} />}</div>
            <select className="inline-select" aria-label="KPI to chart" value={kpi} onChange={(e) => setKpi(e.target.value)}>
              {[...defs.values()].map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
          </div>
          <div className="card-pad stack">
            <div className="row small muted">
              <span>Now <b>{fmtKpi(def.unit, k?.value)}</b></span>·<span>target {fmtKpi(def.unit, k?.target)} (±{fmtKpi(def.unit, k?.amber)})</span>·
              <span>previous period {fmtKpi(def.unit, k?.prev)}</span>·<span className="faint">{def.formula}</span>
            </div>
            {trend.data ? <TrendChart def={def} points={trend.data} /> : <Skeleton rows={3} />}
          </div>
        </div>
      )}
    </>
  );
}

function pathTo(root: ScoreNode, id: string): string[] {
  if (root.id === id) return [root.id];
  for (const c of root.children) {
    const p = pathTo(c, id);
    if (p.length) return [root.id, ...p];
  }
  return [];
}
