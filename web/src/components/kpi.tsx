import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, CircleCheck, CircleAlert, CircleX, Minus } from "lucide-react";
import { deltaGood, dueText, fmtDelta, fmtKpi, PERIODS, useApi, type IssueRow, type KpiDef, type KpiValue, type Rag } from "../api";

/** KPI definitions, fetched once per session (finance ones only for CSDM/COO). */
export function useKpiDefs() {
  const { data } = useApi<KpiDef[]>("/kpis/definitions");
  return useMemo(() => new Map((data ?? []).map((d) => [d.code, d])), [data]);
}

const RAG_TEXT: Record<Rag, string> = { green: "On target", amber: "Near target", red: "Off target", none: "No data" };

/** Status never rides on colour alone: icon + word. */
export function RagChip({ rag, compact }: { rag: Rag; compact?: boolean }) {
  const Icon = rag === "green" ? CircleCheck : rag === "amber" ? CircleAlert : rag === "red" ? CircleX : Minus;
  return (
    <span className={`rag rag-${rag}`} title={RAG_TEXT[rag]}>
      <Icon size={14} aria-hidden />{compact ? <span className="sr-only">{RAG_TEXT[rag]}</span> : RAG_TEXT[rag]}
    </span>
  );
}

export function KpiCell({ def, k }: { def: KpiDef; k?: KpiValue }) {
  if (!k || k.value == null) return <span className="faint">—</span>;
  const good = deltaGood(def, k);
  return (
    <span className={`kcell rag-${k.rag}`} title={`${def.name}: ${fmtKpi(def.unit, k.value)} · target ${fmtKpi(def.unit, k.target)}${k.prev != null ? ` · previous ${fmtKpi(def.unit, k.prev)}` : ""}`}>
      <i aria-hidden className="kdot" />
      <b className="num">{fmtKpi(def.unit, k.value)}</b>
      {good != null && (good ? <ArrowUpRight size={12} className="up" aria-label="improving" /> : <ArrowDownRight size={12} className="down" aria-label="worsening" />)}
    </span>
  );
}

export function KpiTile({ def, k, spark, onClick }: { def: KpiDef; k?: KpiValue; spark?: (number | null)[]; onClick?: () => void }) {
  const good = k ? deltaGood(def, k) : null;
  return (
    <button className={`card ktile rag-${k?.rag ?? "none"}`} onClick={onClick} disabled={!onClick}>
      <div className="row between"><span className="label">{def.name}</span>{k && <RagChip rag={k.rag} compact />}</div>
      <div className="value">{fmtKpi(def.unit, k?.value)}</div>
      <div className="row between sub">
        <span>target {fmtKpi(def.unit, k?.target)}</span>
        {k?.delta != null && <span className={good == null ? "" : good ? "good" : "bad"}>{fmtDelta(def.unit, k.delta)} vs prev.</span>}
      </div>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </button>
  );
}

export function Sparkline({ values, height = 28 }: { values: (number | null)[]; height?: number }) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return null;
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = values.map((x, i) => (x == null ? null : [(i / (values.length - 1)) * 100, height - 3 - ((x - min) / span) * (height - 6)] as const)).filter(Boolean) as [number, number][];
  const last = pts.at(-1)!;
  return (
    <svg className="spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--text-3)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--accent)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One KPI over time against its target, with a hover readout. */
export function TrendChart({ def, points, height = 220 }: { def: KpiDef; points: { period: string; value: number | null; target: number; rag: Rag }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = height, L = 48, R = 12, T = 12, B = 26;
  const vals = points.flatMap((p) => [p.value, p.target]).filter((x): x is number => x != null);
  if (points.length < 2 || !vals.length) return <div className="empty">Not enough data for a trend.</div>;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
  lo -= pad; hi += pad;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
  const line = points.map((p, i) => (p.value == null ? null : `${x(i)},${y(p.value)}`)).filter(Boolean).join(" ");
  const target = points.map((p, i) => `${x(i)},${y(p.target)}`).join(" ");
  const h = hover != null ? points[hover] : null;
  const every = Math.ceil(points.length / 8);
  return (
    <div className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label={`${def.name} trend against target`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1)))));
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)">{fmtKpi(def.unit, t, def.unit === "€" ? 2 : 0)}</text>
          </g>
        ))}
        {points.map((p, i) => i % every === 0 && (
          <text key={p.period} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--text-3)">{p.period.length === 10 ? p.period.slice(5) : p.period}</text>
        ))}
        <polyline points={target} fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="4 4" />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => p.value != null && p.rag === "red" && (
          <circle key={i} cx={x(i)} cy={y(p.value)} r="4" fill="var(--danger-solid)" stroke="var(--surface)" strokeWidth="2" />
        ))}
        {h && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--text-3)" />
            {h.value != null && <circle cx={x(hover)} cy={y(h.value)} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />}
          </g>
        )}
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: "var(--accent)", height: 3 }} />{def.name}</span>
        <span><i className="swatch" style={{ borderTop: "2px dashed var(--text-3)", height: 0 }} />Target</span>
        <span><i className="swatch" style={{ background: "var(--danger-solid)", borderRadius: 99 }} />Off target</span>
        {h && <span className="hover-read"><b>{h.period}</b>: {fmtKpi(def.unit, h.value)} (target {fmtKpi(def.unit, h.target)})</span>}
      </div>
    </div>
  );
}

export function PeriodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Period">
      {PERIODS.map(([v, text]) => <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

export function DueChip({ i }: { i: Pick<IssueRow, "due_at" | "due_in_min" | "due_state"> }) {
  const cls = i.due_state === "overdue" || i.due_state === "done_late" ? "bad" : i.due_state === "due_soon" ? "warn" : i.due_state === "done" ? "ok" : "";
  return <span className={`chip ${cls}`} title={`Due ${new Date(i.due_at).toLocaleString("en-GB")}`}>{dueText(i)}</span>;
}
