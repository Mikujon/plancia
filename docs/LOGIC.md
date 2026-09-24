# Plancia — business logic

How the tool thinks. Every rule here is implemented in `server/domain/` and covered by `tests/domain.test.ts`.

## 1. Hierarchy

```
COO
 └─ CSDM            one per client account (Klarna, Just Eat…)
     └─ Floor Manager   a group of teams inside the account
         └─ Team Leader   one team (or more)
```

- Stored as a reporting line: every person has a `manager_id` (`users` table). Nothing else defines the hierarchy.
- **Visibility = your subtree.** A TL sees their team; an FM their TLs' teams; a CSDM their account; the COO everything. Enforced by the server on every call (`org.ts → visibleTeamIds`).
- **Acting on an action**: its owner, or anyone above the owner in the line. Everyone else in the perimeter can follow and comment.
- **Finance** (revenue, margin, cost per contact, P&L, QBR) is visible to CSDM and COO only.

## 2. Actions, due dates and escalation

Every issue/action has an **owner**, a **status**, a **due date**, an optional **linked KPI** and a **cost/margin impact**.

Two clocks run on every open action (`escalation.ts`):

| Severity | Pick-up deadline | Resolution due date |
|---|---|---|
| critical | 15 min | 4 h |
| high | 30 min | 24 h |
| medium | 2 h | 3 days |
| low | 8 h | 7 days |

- **Pick-up**: the owner must *take* it (status → in progress). Not taken in time → it moves up.
- **Due date**: must be resolved by `due_at`. Missed → it moves up.
- **Moving up = the owner's manager, one level, never skipping** (TL → FM → CSDM → COO). The new owner must pick it up again and gets a fresh window: half the original, at least 1 h, never earlier than the current due date.
- The COO has no one above: overdue items stay visible as overdue.
- Actions you raise for yourself start as picked up. Actions from the system (chat, RTA, KPI breach, Nodo) must be picked up.
- Pushing a due date **later requires a reason**; every change goes on the timeline and is counted in the end-to-end report.
- **Due-date discipline** (per person and per direct report): open, overdue, due today / this week, not picked up, **% closed on time (30 days)**, average days late.

## 3. KPIs (BPO standard)

All KPIs are computed from one table, `kpi_daily` (one row per team per day of raw counts). **Every KPI is a ratio of sums**, so any level of the hierarchy is just the sum of the teams below it, divided once — never an average of averages.

| KPI | Formula | Better | Default target ± band |
|---|---|---|---|
| Service level | answered within threshold ÷ offered | higher | contract (per campaign) ± 5 |
| Abandon rate | abandoned ÷ offered | lower | 5% ± 2 |
| ASA | queue wait ÷ answered | lower | 30 s ± 10 |
| AHT | (talk + hold + ACW) ÷ answered | lower | per campaign |
| Occupancy | handle time ÷ logged-in time | band | 85% ± 5 |
| Schedule adherence | time in adherence ÷ time worked | higher | 92% ± 3 |
| Shrinkage | (paid − logged-in) ÷ paid | lower | 30% ± 3 |
| Absenteeism | unplanned absence ÷ paid | lower | 6% ± 2 |
| Attrition (monthly) | leavers ÷ average headcount | lower | 3% ± 1 |
| Staffing vs requirement | logged-in ÷ WFM required hours | band | 100% ± 5 |
| Volume vs forecast | (offered − forecast) ÷ forecast | band | 0% ± 5 |
| FCR | resolved first time ÷ surveyed | higher | 75% ± 5 |
| CSAT | satisfied ÷ responses | higher | 85% ± 3 |
| QA score | audit points ÷ audits | higher | 88% ± 3 |
| Cost per contact *(finance)* | labour cost ÷ answered | lower | per campaign |
| Gross margin *(finance)* | (revenue − labour − SLA penalties) ÷ revenue | higher | per campaign |

- **Targets** live per campaign in `kpi_targets` (contract values); defaults above apply otherwise. Service level uses the campaign's contractual `sla_target_pct`.
- **Combined targets** (an FM or CSDM with several campaigns) are the campaigns' targets **weighted by each campaign's own volume** for that KPI (e.g. offered contacts for SL).
- **Status**: green = on target; amber = within the tolerance band; red = outside it. "Band" KPIs are green within ±band, amber within ±2×band.
- **Periods**: yesterday / last 7 / 30 / 90 closed days, always compared with the previous period of the same length.

### Finance model (per team, per day)
- revenue = logged-in hours × billing rate
- labour = paid hours × hourly cost + overtime hours × hourly cost × overtime multiplier
- SLA penalty = the campaign's daily penalty when the campaign's **whole-day** service level misses contract, shared across its teams by offered volume.
- Cost logged on issues **explains** margin leakage; it is not added on top.

## 4. Analysis

- **Exceptions**: every KPI in red at team level (finance at account level), ranked by how far outside its band it is. Each shows the last 7 days and whether an action is open for it.
- **Service-level drivers** (also for ASA and abandon misses) — each measured against its norm; adverse ones are listed worst first:
  - volume > 5% over forecast
  - staffing > 5% under WFM requirement
  - AHT > 5% over target
  - adherence < 90%
  - absenteeism > 8%
- **Movers**: biggest changes vs the previous period, measured in tolerance bands so different KPIs compare fairly.
- **League table**: teams (or FMs) ranked on **variance to their own target**, with quartiles — so a 540 s Disputes AHT and a 300 s Courier AHT are compared on the same basis.

## 5. Automation

Every 30 seconds (`main.ts`):
1. **Escalation** — pick-up and due-date clocks (section 2).
2. **KPI breach → action** — a watched KPI (SL, AHT, adherence, absenteeism, QA, CSAT) red for **3 closed days in a row** opens an action for the team's TL, with the daily values and the likely drivers, unless one is already open for that team and KPI. From there the normal clocks apply.
3. **RTA gap → action** — a live staffing gap of ≥15% (and ≥2 heads) opens a staffing action for the TL.

## 6. Reports

| Report | For | Content |
|---|---|---|
| Daily ops report | everyone | yesterday vs the day before: scorecard (you + direct reports), exceptions with drivers and owners, movers, due-date discipline, escalations |
| Weekly business review | everyone | the same over 7 days vs the previous 7 |
| Client QBR | CSDM, COO | contract KPIs by month vs target, days on target, issues and main incidents — client-facing text has **no margin**; internal numbers shown apart |
| P&L | CSDM, COO | revenue, labour, penalties, margin by campaign, daily margin, CSV |
| End-to-end issue report | everyone (margin share: CSDM/COO) | ownership chain, time per level, due-date changes, full timeline, cost and share of that day's margin |

All reports copy as Markdown for the daily call, the WBR deck or the QBR.

## 7. Data the real systems must provide

`kpi_daily` per team per day: offered, forecast, answered, answered within threshold, abandoned, handle hours, wait hours, paid hours, logged-in hours, WFM required hours, adherent hours, absent hours, overtime hours, FCR yes/surveyed, CSAT positive/responses, QA points/audits. Plus `headcount_monthly` (average headcount, leavers).

Typical sources: ACD/telephony (volumes, SL, AHT, wait), WFM/RTA (forecast, required, adherence, schedule), HR/payroll (paid, absence, overtime, leavers), QA and survey tools. The demo database is seeded with 60 days of realistic data including four planted patterns: KCS Bravo AHT drift, Courier Day Monday absenteeism, Care IT Roma QA dip, and Disputes Chargeback month-start volume.
