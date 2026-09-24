import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Archive as ArchiveIcon, ArrowRightLeft, ChartLine, FileText, Gauge, LayoutDashboard, ListChecks, LogOut,
  MessageSquareWarning, Plug, Search, SquareKanban, TriangleAlert, Users, type LucideProps,
} from "lucide-react";
import { api, ROLE_NAME, setUser, useApi, useLive, useUserId, type IssueRow, type Org, type Role, type User } from "./api";
import { AppCtx, Skeleton } from "./components/ui";
import { IssueDrawer } from "./components/IssueDrawer";
import { Home } from "./pages/Home";
import { Board } from "./pages/Board";
import { Inbox } from "./pages/Inbox";
import { Staffing } from "./pages/Staffing";
import { Handovers } from "./pages/Handovers";
import { Archive } from "./pages/Archive";
import { IssueReport, Reports } from "./pages/Reports";
import { IntegrationsPage } from "./pages/Admin";
import { Kpis } from "./pages/Kpis";
import { Analysis } from "./pages/Analysis";
import { Actions } from "./pages/Actions";

function useHash() {
  const [h, setH] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setH(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

const HOME_NAME: Record<Role, string> = { TL: "Overview", FM: "Overview", CSDM: "Overview", COO: "Overview" };

export function App() {
  const userId = useUserId();
  const org = useApi<Org>("/org");
  if (!org.data) return org.error ? <div className="empty">{org.error}</div> : <Skeleton rows={6} />;
  const me = org.data.users.find((u) => u.id === userId);
  if (!me) return <SignIn org={org.data} />;
  return <Shell key={me.id} org={org.data} me={me} />;
}

function SignIn({ org }: { org: Org }) {
  const roles: Role[] = ["TL", "FM", "CSDM", "COO"];
  return (
    <div className="login">
      <div className="card">
        <div className="card-head"><div className="row"><span className="brand-mark">P</span><h1>Plancia</h1></div><span className="faint small">operations coordination</span></div>
        <div className="card-pad stack">
          <p className="muted" style={{ margin: 0 }}>Demo sign-in: pick a person to see their part of the hierarchy — COO → CSDM → Floor Manager → Team Leader. Production uses company SSO.</p>
          {roles.map((r) => (
            <div key={r} className="stack" style={{ gap: 6 }}>
              <h3>{ROLE_NAME[r]}</h3>
              <div className="people">
                {org.users.filter((u) => u.role === r).map((u) => {
                  const manager = org.users.find((x) => x.id === u.manager_id);
                  const scope = r === "TL" ? org.teams.filter((t) => t.tl_id === u.id).map((t) => t.name).join(", ")
                    : r === "FM" ? org.users.filter((x) => x.manager_id === u.id).map((x) => org.teams.find((t) => t.tl_id === x.id)?.name).filter(Boolean).join(", ")
                    : r === "CSDM" ? `${[...new Set(org.campaigns.filter((c) => c.csdm_id === u.id).map((c) => org.clients.find((x) => x.id === c.client_id)?.name))].join(", ")} account`
                    : "every account";
                  const line = manager ? `${scope} · reports to ${manager.name}` : scope;
                  return <button key={u.id} className="person" onClick={() => setUser(u.id)}><b>{u.name}</b><div className="faint small">{line}</div></button>;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Shell({ org, me }: { org: Org; me: User }) {
  const hash = useHash();
  const live = useLive();
  const [issueId, setIssueId] = useState<string | null>(null);
  const scope = useApi<{ team_ids: string[]; campaign_ids: string[] }>("/me");
  const inbox = useApi<unknown[]>("/inbox");
  const mine = useApi<IssueRow[]>(`/issues?status=open&owner=me`, 60_000);
  const open = useApi<IssueRow[]>(`/issues?status=open`, 30_000);
  const critical = (open.data ?? []).filter((i) => i.severity === "critical");
  const dueSoon = (open.data ?? []).filter((i) => i.escalates_in_min != null && i.escalates_in_min <= 10);
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("plancia.theme") ?? "auto"; } catch { return "auto"; } });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("plancia.theme", theme); } catch { /* ignore */ }
  }, [theme]);

  const ctx = useMemo(() => ({
    org, me,
    teamIds: new Set(scope.data?.team_ids ?? []),
    campaignIds: new Set(scope.data?.campaign_ids ?? []),
    openIssue: (id: string) => setIssueId(id),
  }), [org, me, scope.data]);

  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query ?? "");
  const parts = path.split("/").filter(Boolean);
  const route = parts[0] ?? "";

  let page;
  if (!scope.data) page = <Skeleton rows={6} />;
  else if (route === "board") page = <Board campaignId={parts[1]} />;
  else if (route === "kpis") page = <Kpis key={hash} nodeParam={params.get("node") ?? undefined} kpiParam={params.get("kpi") ?? undefined} />;
  else if (route === "analysis") page = <Analysis />;
  else if (route === "actions") page = <Actions />;
  else if (route === "inbox") page = <Inbox />;
  else if (route === "staffing") page = <Staffing />;
  else if (route === "handovers") page = <Handovers />;
  else if (route === "archive") page = <Archive />;
  else if (route === "reports") page = <Reports clientParam={params.get("client") ?? undefined} />;
  else if (route === "report" && parts[1]) page = <IssueReport id={parts[1]} />;
  else if (route === "integrations") page = <IntegrationsPage />;
  else page = <Home />;

  const nav = ([
    ["", HOME_NAME[me.role], LayoutDashboard],
    ["kpis", "KPI scorecard", Gauge],
    ["analysis", "Analysis", ChartLine],
    ["actions", "Actions & due dates", ListChecks, mine.data?.length],
    ["reports", "Reports", FileText],
    ["staffing", "Workforce", Users],
    ["handovers", "Handovers", ArrowRightLeft],
    ["inbox", "Chat inbox", MessageSquareWarning, inbox.data?.length],
    ["board", "Campaign boards", SquareKanban],
    ["archive", "Archive & patterns", ArchiveIcon],
    ["integrations", "Integrations", Plug],
  ] as [string, string, ComponentType<LucideProps>, number?][]).filter(([r]) =>
    (r !== "handovers" || me.role === "TL" || me.role === "FM") && (r !== "integrations" || me.role === "COO" || me.role === "CSDM"));

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <aside className="side">
          <div className="brand"><span className="brand-mark" aria-hidden>P</span><span>Plancia</span></div>
          <nav className="nav" aria-label="Main">
            {nav.map(([r, label, Icon, n]) => (
              <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined}>
                <Icon size={18} aria-hidden /><span className="label">{label}</span>
                {n ? <span className="count" aria-label={`${n} waiting`}>{n}</span> : null}
              </a>
            ))}
          </nav>
          <div className="side-foot">
            <span className={`live ${live ? "on" : ""}`} role="status"><i aria-hidden />{live ? "Live — updates as they happen" : "Reconnecting…"}</span>
            <select className="inline-select" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
              <option value="auto">Theme: system</option><option value="light">Theme: light</option><option value="dark">Theme: dark</option>
            </select>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="row">
              <span className={`chip ${me.role}`}>{ROLE_NAME[me.role]}</span>
              <b>{me.name}</b>
            </div>
            <div className="row">
              <QuickFind onOpen={(id) => setIssueId(id)} />
              <button className="btn sm ghost" onClick={() => setUser(null)}><LogOut size={16} aria-hidden />Switch person</button>
            </div>
          </header>
          {(critical.length > 0 || dueSoon.length > 0) && (
            <div className="alert-bar" role="status">
              <TriangleAlert size={16} aria-hidden />
              {critical.length > 0 && <span>{critical.length} critical open:</span>}
              {critical.slice(0, 3).map((i) => (
                <a key={i.id} href="#" onClick={(e) => { e.preventDefault(); setIssueId(i.id); }}>{i.ref} {i.title}</a>
              ))}
              {dueSoon.length > 0 && <span>· {dueSoon.length} escalate within 10 min</span>}
            </div>
          )}
          <main className="page">{page}</main>
        </div>
      </div>
      {issueId && <IssueDrawer id={issueId} onClose={() => setIssueId(null)} />}
    </AppCtx.Provider>
  );
}

function QuickFind({ onOpen }: { onOpen: (id: string) => void }) {
  const [ref, setRef] = useState("");
  const [err, setErr] = useState(false);
  const go = async () => {
    try { const r = await api<{ issue: IssueRow }>(`/issues/${encodeURIComponent(ref.trim().toUpperCase())}`); onOpen(r.issue.id); setRef(""); setErr(false); }
    catch { setErr(true); }
  };
  return (
    <div className="search">
      <Search size={16} aria-hidden />
      <input style={{ width: 220, borderColor: err ? "var(--danger)" : undefined }} placeholder="Open by ref, e.g. KCS-0012" value={ref}
        onChange={(e) => { setRef(e.target.value); setErr(false); }} onKeyDown={(e) => e.key === "Enter" && ref.trim() && go()}
        aria-label="Open issue by reference" aria-invalid={err} />
    </div>
  );
}
