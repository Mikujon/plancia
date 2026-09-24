# Plancia — BPO operations management

KPIs, analysis, reports and actions with due dates for a contact-centre BPO, along the reporting line
**COO → CSDM → Floor Manager → Team Leader**. Standalone; Nodo connects through the versioned `ops.v1` API.

- **Business logic**: [docs/LOGIC.md](docs/LOGIC.md) — hierarchy, due dates and escalation, KPI formulas and targets, analysis, reports.
- **Nodo integration**: [docs/NODO-INTEGRATION.md](docs/NODO-INTEGRATION.md).

## Run it

Needs Node 24+ (uses the built-in `node:sqlite`) and pnpm.

**Quick start on Windows:** double-click `Start Plancia.cmd`. It installs dependencies the first time, starts the app and opens http://localhost:5173. Close its window to stop it.

```bash
pnpm install
pnpm dev          # API :8787 + UI :5173 → open http://localhost:5173
pnpm test         # business rules + ops.v1 conformity kit
pnpm seed         # wipe and reseed the demo database (60 days of KPI data)
pnpm build && pnpm start   # production: the API serves the built UI on :8787
```

Copy `.env.example` to `.env` for API tokens, chat webhooks and the WFM feed. Sign-in is a demo person picker; swap in company SSO before go-live.

## What's in it

| Area | What it does |
|---|---|
| Overview | Your KPIs vs target, your direct reports' scorecard, exceptions, what's due |
| KPI scorecard | 16 BPO KPIs down the hierarchy (ratio of sums, volume-weighted targets), status and trend vs target |
| Analysis | Exceptions with service-level drivers, movers vs previous period, league table vs own target |
| Actions & due dates | Owner, due date, linked KPI, cost impact; pick-up and due-date clocks escalate one level at a time |
| Reports | Daily ops report, weekly business review, client QBR, P&L, end-to-end issue report — all copy as Markdown |
| Workforce | Live headcount vs requirement per campaign and shift, cost of each gap |
| Handovers | Shift handover for TLs and FMs; open actions carry over |
| Chat inbox | Flagged Google Chat / Telegram messages become owned actions in one click |
| Campaign boards | One board per client campaign, columns by level |
| Archive & patterns | Searchable history, cost by category and weekday |

## Layout

```
server/
  domain/       org (hierarchy), issues (actions, due dates), escalation (clocks), kpi (engine),
                analysis, reports, staffing, chat, handovers, cost
  api/          internal (UI), public-v1 (Nodo), webhooks (chat)
  contracts/    ops.v1.ts — the public contract, self-contained
  adapters/     WFM/RTA (mock | http + traduzione), Telegram, Google Chat
  seed.ts       demo organisation and 60 days of data
web/src/        React UI (live updates via server-sent events)
tests/          domain tests + conformita-ops.ts (reusable conformity kit)
docs/           LOGIC.md, NODO-INTEGRATION.md
```

## Before production

- Company SSO instead of the person picker; load users and `manager_id` from HR.
- Feed `kpi_daily` and `headcount_monthly` from the real ACD, WFM/RTA, HR and QA systems (fields in docs/LOGIC.md §7).
- Load contract targets into `kpi_targets` per campaign.
- Google Chat: verify Google's signed bearer JWT on each call, in addition to the URL token.
- Set the site time zone (shift times are UTC in the demo).
- SQLite fits one site; move to Postgres if several instances must share state.
