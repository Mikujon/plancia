import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('TL','FM','CSDM','COO')),
  email TEXT,
  manager_id TEXT REFERENCES users(id)  -- reporting line: TL → FM → CSDM → COO
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  hourly_cost REAL NOT NULL,          -- loaded agent cost, EUR/hour
  billing_rate REAL NOT NULL,         -- billed to client, EUR/hour
  overtime_multiplier REAL NOT NULL,
  sla_target_pct REAL NOT NULL,       -- contractual service level, % answered within sl_threshold_sec
  sl_threshold_sec INTEGER NOT NULL,
  sla_penalty_per_day REAL NOT NULL,  -- contractual penalty when the daily service level is missed
  csdm_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS floors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  floor_id TEXT NOT NULL REFERENCES floors(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  tl_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_hhmm TEXT NOT NULL,
  end_hhmm TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_shift_plan (
  team_id TEXT NOT NULL REFERENCES teams(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  required INTEGER NOT NULL,
  PRIMARY KEY (team_id, shift_id)
);
CREATE TABLE IF NOT EXISTS staffing_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id),
  shift_id TEXT NOT NULL,
  date TEXT NOT NULL,
  required INTEGER NOT NULL,
  scheduled INTEGER NOT NULL,
  present INTEGER NOT NULL,
  source TEXT NOT NULL,               -- rta | manual
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS staffing_by_day ON staffing_snapshots(date, team_id, shift_id, observed_at);

-- One row per team per day: the raw counts every KPI is computed from.
-- All KPIs are ratios of sums, so any level of the hierarchy is just a SUM of these rows.
CREATE TABLE IF NOT EXISTS kpi_daily (
  date TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  offered INTEGER NOT NULL,           -- contacts offered to the queue
  forecast INTEGER NOT NULL,          -- contacts forecast by WFM
  answered INTEGER NOT NULL,
  answered_in_sl INTEGER NOT NULL,    -- answered within the campaign threshold
  abandoned INTEGER NOT NULL,
  handle_hours REAL NOT NULL,         -- talk + hold + after-call work
  wait_hours REAL NOT NULL,           -- total queue wait of answered contacts
  paid_hours REAL NOT NULL,           -- scheduled paid hours
  logged_hours REAL NOT NULL,         -- hours logged in and available or handling
  required_hours REAL NOT NULL,       -- logged hours WFM said were needed to meet SL
  adherent_hours REAL NOT NULL,       -- logged hours that matched the schedule
  absent_hours REAL NOT NULL,         -- unplanned absence
  overtime_hours REAL NOT NULL,
  fcr_yes INTEGER NOT NULL, fcr_n INTEGER NOT NULL,
  csat_pos INTEGER NOT NULL, csat_n INTEGER NOT NULL,
  qa_points REAL NOT NULL, qa_n INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (date, team_id)
);
CREATE TABLE IF NOT EXISTS headcount_monthly (
  month TEXT NOT NULL,                -- YYYY-MM
  team_id TEXT NOT NULL REFERENCES teams(id),
  headcount REAL NOT NULL,            -- average headcount in the month
  leavers INTEGER NOT NULL,
  PRIMARY KEY (month, team_id)
);
-- Contractual / internal targets per campaign. amber = tolerance band in the KPI's own unit.
CREATE TABLE IF NOT EXISTS kpi_targets (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  kpi TEXT NOT NULL,
  target REAL NOT NULL,
  amber REAL NOT NULL,
  PRIMARY KEY (campaign_id, kpi)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,             -- staffing | system | quality | client | sla | hr | other
  severity TEXT NOT NULL,             -- low | medium | high | critical
  status TEXT NOT NULL,               -- open | in_progress | resolved | closed
  layer TEXT NOT NULL,                -- TL | FM | CSDM | COO
  layer_since TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  raised_by TEXT,
  source TEXT NOT NULL,               -- floor | google_chat | telegram | rta | nodo
  source_ref TEXT,
  sla_related INTEGER NOT NULL DEFAULT 0,
  impact_type TEXT NOT NULL DEFAULT 'none', -- none | overtime | understaffing | sla_penalty | other
  impact_hours REAL NOT NULL DEFAULT 0,
  impact_amount REAL NOT NULL DEFAULT 0,
  resolution TEXT,
  kpi TEXT,                           -- KPI this action addresses, if any
  due_at TEXT NOT NULL,               -- resolution due date
  acknowledged_at TEXT,               -- when the owner picked it up
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS issues_by_campaign ON issues(campaign_id, status);
CREATE INDEX IF NOT EXISTS issues_by_updated ON issues(updated_at, id);

CREATE TABLE IF NOT EXISTS issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  at TEXT NOT NULL,
  actor_id TEXT,                      -- null = system (auto-escalation, RTA feed)
  type TEXT NOT NULL,                 -- created | assigned | status | escalated | comment | cost | due | resolved | reopened
  from_value TEXT,
  to_value TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS events_by_issue ON issue_events(issue_id, at);

CREATE TABLE IF NOT EXISTS handovers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  date TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  notes TEXT NOT NULL,
  headcount_note TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handover_issues (
  handover_id TEXT NOT NULL REFERENCES handovers(id),
  issue_id TEXT NOT NULL REFERENCES issues(id),
  PRIMARY KEY (handover_id, issue_id)
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,               -- google_chat | telegram
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id),
  external_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  issue_id TEXT REFERENCES issues(id),
  UNIQUE (group_id, external_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file = process.env.PLANCIA_DB ?? "data/plancia.db"): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function all<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: DB, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function isEmpty(db: DB): boolean {
  return (get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users")?.n ?? 0) === 0;
}
