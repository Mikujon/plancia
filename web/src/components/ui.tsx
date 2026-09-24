import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUp, ChevronDown, ChevronUp, ChevronsUpDown, CircleAlert, X } from "lucide-react";
import {
  api, CATEGORIES, dueText, eur, IMPACT_NAME, IMPACTS, SEVERITIES, useApi, type IssueRow, type Org, type Role, type User,
} from "../api";

// ── app context ──
export interface Ctx { org: Org; me: User; teamIds: Set<string>; campaignIds: Set<string>; openIssue: (id: string) => void }
export const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

// ── small pieces ──
export const LayerChip = ({ layer }: { layer: Role }) => <span className={`chip ${layer}`}>{layer}</span>;
export const SevChip = ({ s }: { s: string }) => <span className={`chip ${s}`}>{s}</span>;
export const StatusChip = ({ s }: { s: string }) => (
  <span className={`chip ${s === "resolved" || s === "closed" ? "ok" : s === "in_progress" ? "warn" : ""}`}>{s.replace("_", " ")}</span>
);
export const Money = ({ n, zero = "—" }: { n: number; zero?: string }) => <span className="num">{n ? eur(n) : zero}</span>;

export function EscalationClock({ i }: { i: Pick<IssueRow, "escalates_in_min" | "layer" | "status"> }) {
  if (i.status === "resolved" || i.status === "closed") return null;
  if (i.escalates_in_min == null) return <span className="clock faint">stays at {i.layer}</span>;
  const m = i.escalates_in_min;
  if (m <= 0) return <span className="clock due"><ArrowUp size={14} aria-hidden />escalating now</span>;
  return (
    <span className={`clock ${m <= 10 ? "due" : m <= 30 ? "soon" : "faint"}`} title="Moves to the next layer automatically if not resolved">
      <ArrowUp size={14} aria-hidden /><span className="sr-only">Escalates</span>in {m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`}
    </span>
  );
}

export function Kpi({ label, value, sub, alert }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean }) {
  return (
    <div className={`card kpi ${alert ? "alert" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function IssueList({ rows, empty = "Nothing open here.", showCampaign = true }: { rows: IssueRow[] | null; empty?: string; showCampaign?: boolean }) {
  const { openIssue } = useApp();
  if (!rows) return <Skeleton />;
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div>
      {rows.map((i) => (
        <div key={i.id} className={`issue sev-${i.severity}`} onClick={() => openIssue(i.id)} role="button" tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && openIssue(i.id)}>
          <div className="row between">
            <span className="issue-title">{i.title}</span>
            <span className="row">{i.impact_amount > 0 && <span className="chip bad num">{eur(i.impact_amount)}</span>}<SevChip s={i.severity} /></span>
          </div>
          <div className="issue-meta">
            <span className="mono">{i.ref}</span>
            <LayerChip layer={i.layer} />
            <span>{i.owner_name}</span>
            <span>·</span>
            <span>{i.team_name}{showCampaign ? ` · ${i.campaign_name}` : ""}</span>
            {i.source !== "floor" && <SourceTag s={i.source} />}
            {i.kpi && <span className="chip">KPI · {i.kpi}</span>}
            <span style={{ marginLeft: "auto" }} className="row">
              <span className={`chip ${i.due_state === "overdue" ? "bad" : i.due_state === "due_soon" ? "warn" : ""}`}>{dueText(i)}</span>
              <EscalationClock i={i} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, foot }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head"><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function ErrorNote({ e }: { e: string | null }) {
  return e ? <div className="error" role="alert"><CircleAlert size={16} aria-hidden />{e}</div> : null;
}

/** Hours → EUR preview, the same formula the server applies. */
export function impactPreview(type: string, hours: number, amount: number | null, c?: { hourly_cost: number; billing_rate: number; overtime_multiplier?: number }) {
  if (!c) return 0;
  if (type === "overtime") return hours * c.hourly_cost * (c.overtime_multiplier ?? 1.3);
  if (type === "understaffing") return hours * c.billing_rate;
  return amount ?? 0;
}

export function ImpactFields({ v, set, campaignId }: {
  v: { impact_type: string; impact_hours: number; impact_amount: number | null };
  set: (p: Partial<{ impact_type: string; impact_hours: number; impact_amount: number | null }>) => void;
  campaignId?: string;
}) {
  const { org } = useApp();
  const c = org.campaigns.find((x) => x.id === campaignId);
  const byHours = v.impact_type === "overtime" || v.impact_type === "understaffing";
  const byAmount = v.impact_type === "sla_penalty" || v.impact_type === "other";
  return (
    <div className="grid g3">
      <label className="f">Cost / margin impact
        <select value={v.impact_type} onChange={(e) => set({ impact_type: e.target.value })}>
          {IMPACTS.map((x) => <option key={x} value={x}>{IMPACT_NAME[x]}</option>)}
        </select>
      </label>
      {byHours && <label className="f">Hours
        <input type="number" min={0} step={0.5} value={v.impact_hours} onChange={(e) => set({ impact_hours: Number(e.target.value) })} />
      </label>}
      {byAmount && <label className="f">Amount (EUR){v.impact_type === "sla_penalty" ? " — blank = 1 day's penalty" : ""}
        <input type="number" min={0} value={v.impact_amount ?? ""} onChange={(e) => set({ impact_amount: e.target.value === "" ? null : Number(e.target.value) })} />
      </label>}
      {v.impact_type !== "none" && c && (
        <div className="f" style={{ alignSelf: "end", paddingBottom: 8 }}>
          <span className="faint small">{byHours ? `${v.impact_type === "overtime" ? `€${c.hourly_cost}/h × OT rate` : `€${c.billing_rate}/h billed`}` : ""}</span>
          <strong className="num">≈ {eur(impactPreview(v.impact_type, v.impact_hours, v.impact_amount, c as never))}</strong>
        </div>
      )}
    </div>
  );
}

const RESOLVE_HOURS: Record<string, number> = { critical: 4, high: 24, medium: 72, low: 168 };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export interface IssuePreset { title?: string; description?: string; kpi?: string; category?: string; severity?: string }

export function NewIssueModal({ onClose, teamId, preset }: { onClose: () => void; teamId?: string; preset?: IssuePreset }) {
  const { org, teamIds, me, openIssue } = useApp();
  const kpis = useApi<{ code: string; name: string }[]>("/kpis/definitions");
  const myTeams = org.teams.filter((t) => teamIds.has(t.id));
  const defaultTeam = teamId ?? org.teams.find((t) => t.tl_id === me.id)?.id ?? myTeams[0]?.id ?? "";
  const [f, setF] = useState({
    team_id: defaultTeam, title: preset?.title ?? "", description: preset?.description ?? "", category: preset?.category ?? "staffing",
    severity: preset?.severity ?? "medium", sla_related: false, kpi: preset?.kpi ?? "",
    impact_type: "none", impact_hours: 0, impact_amount: null as number | null,
  });
  const [due, setDue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const team = org.teams.find((t) => t.id === f.team_id);
  const defaultDue = new Date(Date.now() + RESOLVE_HOURS[f.severity] * 3_600_000);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const i = await api<{ id: string }>("/issues", { method: "POST", body: {
        ...f, kpi: f.kpi || undefined, impact_amount: f.impact_amount ?? undefined,
        due_at: due ? new Date(due).toISOString() : undefined,
      } });
      onClose(); openIssue(i.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="New action" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.title.length < 3} onClick={submit}>Create action</button></>}>
      <label className="f">Team
        <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}>
          {myTeams.map((t) => <option key={t.id} value={t.id}>{t.name} — {org.campaigns.find((c) => c.id === t.campaign_id)?.name}</option>)}
        </select>
      </label>
      <label className="f">What needs to happen
        <input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Bring AHT back under 420s on KCS Bravo" />
      </label>
      <label className="f">Details
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </label>
      <div className="grid g3">
        <label className="f">Category
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="f">Severity
          <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="f">Linked KPI
          <select value={f.kpi} onChange={(e) => setF({ ...f, kpi: e.target.value })}>
            <option value="">None</option>
            {(kpis.data ?? []).map((k) => <option key={k.code} value={k.code}>{k.name}</option>)}
          </select>
        </label>
      </div>
      <div className="grid g2">
        <label className="f">Due date
          <input type="datetime-local" value={due} min={localInput(new Date())} onChange={(e) => setDue(e.target.value)} />
          <span className="faint small">Empty = {RESOLVE_HOURS[f.severity] < 48 ? `${RESOLVE_HOURS[f.severity]} h` : `${RESOLVE_HOURS[f.severity] / 24} days`} for {f.severity} ({defaultDue.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })})</span>
        </label>
        <label className="f">Client / SLA related
          <select value={f.sla_related ? "y" : "n"} onChange={(e) => setF({ ...f, sla_related: e.target.value === "y" })}><option value="n">No</option><option value="y">Yes</option></select>
        </label>
      </div>
      <ImpactFields v={f} set={(p) => setF({ ...f, ...p })} campaignId={team?.campaign_id} />
      <p className="faint small" style={{ margin: 0 }}>
        Owned by you ({me.role}) if it's your own action, otherwise by the team's TL. Not picked up in time, or not closed by the due date,
        it moves to the owner's manager: TL → Floor Manager → CSDM → COO.
      </p>
      <ErrorNote e={err} />
    </Modal>
  );
}

export function Bars({ data, height = 120, color = "var(--accent)", format = (n: number) => String(n), label = "Bar chart" }: {
  data: { label: string; value: number; tone?: "bad" }[]; height?: number; color?: string; format?: (n: number) => string; label?: string;
}) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const w = 100 / Math.max(1, data.length);
  const pid = useMemo(() => `hatch-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }} role="img" aria-label={label}>
      <defs>
        {/* flagged bars are hatched as well as red, so the signal survives without colour */}
        <pattern id={pid} width="2" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="4" fill="var(--danger-solid)" /><rect width="0.8" height="4" fill="var(--surface)" />
        </pattern>
      </defs>
      {data.map((d, i) => {
        const h = (Math.abs(d.value) / max) * (height - 4);
        return (
          <rect key={i} x={i * w + w * 0.12} width={w * 0.76} y={height - h} height={h}
            fill={d.tone === "bad" ? `url(#${pid})` : color}>
            <title>{`${d.label}: ${format(d.value)}${d.tone === "bad" ? " (flagged)" : ""}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="skel" aria-busy="true" aria-label="Loading">{Array.from({ length: rows * 2 }, (_, k) => <i key={k} />)}</div>;
}

const SOURCE_NAME: Record<string, string> = { telegram: "Telegram", google_chat: "Google Chat", rta: "RTA feed", nodo: "Nodo", floor: "Floor" };
export const SourceTag = ({ s }: { s: string }) => <span className={`src ${s}`}>{SOURCE_NAME[s] ?? s}</span>;

export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/** Client-side sorting for data tables; headers announce their state with aria-sort. */
export function useSort<T>(rows: T[] | null | undefined, initial: { key: keyof T; dir: "asc" | "desc" }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    if (!rows) return rows ?? null;
    const out = [...rows];
    out.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      return sort.dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, sort]);
  const th = (key: keyof T, text: string, right = false) => {
    const on = sort.key === key;
    const Icon = !on ? ChevronsUpDown : sort.dir === "asc" ? ChevronUp : ChevronDown;
    return (
      <th className={right ? "r" : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button className="sort" onClick={() => setSort({ key, dir: on && sort.dir === "desc" ? "asc" : "desc" })}>
          {text}<Icon size={14} aria-hidden />
        </button>
      </th>
    );
  };
  return { sorted, th };
}
