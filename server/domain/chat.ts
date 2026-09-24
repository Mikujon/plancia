import { randomUUID } from "node:crypto";
import { all, get, run, type DB } from "../db.ts";
import type { InboundMessage } from "../ports/chat.ts";
import { createIssue, type Deps } from "./issues.ts";
import { assertTeamVisible, visibleTeamIds } from "./org.ts";
import { addDays, iso } from "./time.ts";
import { DomainError, type Category, type Role, type Severity, type User } from "./types.ts";

export interface ChatGroup { id: string; source: string; external_id: string; name: string; team_id: string }
export interface MessageRow {
  id: string; group_id: string; group_name: string; source: string; team_id: string; team_name: string;
  campaign_id: string; author: string; text: string; sent_at: string; flagged: number; dismissed: number;
  issue_id: string | null; issue_ref: string | null;
}

const FLAG = /(#issue|#problema|#escalate|🚩|‼️|\bURGENT\b)/i;

export function isFlagged(m: Pick<InboundMessage, "text" | "flagged_by_command">) {
  return Boolean(m.flagged_by_command) || FLAG.test(m.text);
}

/** First guess at category and severity from the message text; the TL can change both. */
export function triage(text: string): { category: Category; severity: Severity; sla_related: boolean } {
  const t = text.toLowerCase();
  const category: Category =
    /\b(sla|queue|wait time|abandon|service level|backlog)\b/.test(t) ? "sla"
    : /\b(down|outage|crash|freez|login|vpn|phone line|cti|dialer|system|tool)\w*/.test(t) ? "system"
    : /\b(sick|absent|no.?show|late|short|understaff|headcount|overtime)\w*/.test(t) ? "staffing"
    : /\b(client|customer complain|escalation from|klarna|just eat)\b/.test(t) ? "client"
    : /\b(qa|quality|audit|script|compliance)\b/.test(t) ? "quality"
    : /\b(hr|conflict|harass|contract|payroll)\b/.test(t) ? "hr"
    : "other";
  const severity: Severity =
    /(urgent|‼️|asap|critical|all agents|whole floor|entire)/.test(t) ? "critical"
    : /(down|outage|🚩|breach|penalt)/.test(t) ? "high"
    : "medium";
  return { category, severity, sla_related: category === "sla" || category === "client" };
}

export const groups = (db: DB) => all<ChatGroup>(db, "SELECT * FROM chat_groups ORDER BY source, name");

export function mapGroup(d: Deps, g: { source: string; external_id: string; name: string; team_id: string }) {
  const id = randomUUID();
  run(d.db, `INSERT INTO chat_groups (id, source, external_id, name, team_id) VALUES (?,?,?,?,?)
    ON CONFLICT (source, external_id) DO UPDATE SET name = excluded.name, team_id = excluded.team_id`,
    id, g.source, g.external_id, g.name, g.team_id);
  return get<ChatGroup>(d.db, "SELECT * FROM chat_groups WHERE source = ? AND external_id = ?", g.source, g.external_id)!;
}

/** Stores a message from a mapped group. Unmapped groups are refused, so nothing lands without an owner. */
export function ingest(d: Deps, m: InboundMessage): { stored: boolean; reason?: string; id?: string } {
  const g = get<ChatGroup>(d.db, "SELECT * FROM chat_groups WHERE source = ? AND external_id = ?", m.source, m.group_external_id);
  if (!g) return { stored: false, reason: "group_not_mapped" };
  const id = randomUUID();
  const r = run(d.db, `INSERT OR IGNORE INTO chat_messages (id, group_id, external_id, author, text, sent_at, flagged)
    VALUES (?,?,?,?,?,?,?)`, id, g.id, m.message_external_id, m.author, m.text, m.sent_at, isFlagged(m) ? 1 : 0);
  if (r.changes === 0) return { stored: false, reason: "duplicate" };
  d.bus.emit({ entity: "chat", id });
  return { stored: true, id };
}

export function inbox(d: Deps, u: User, f: { view?: "flagged" | "all"; hours?: number } = {}): MessageRow[] {
  const ids = [...visibleTeamIds(d.db, u)];
  if (!ids.length) return [];
  const since = iso(addDays(d.clock(), -(f.hours ?? 48) / 24));
  const flaggedOnly = f.view !== "all";
  return all<MessageRow>(d.db, `
    SELECT m.*, g.name AS group_name, g.source, g.team_id, t.name AS team_name, t.campaign_id, i.ref AS issue_ref
    FROM chat_messages m JOIN chat_groups g ON g.id = m.group_id JOIN teams t ON t.id = g.team_id
    LEFT JOIN issues i ON i.id = m.issue_id
    WHERE g.team_id IN (${ids.map(() => "?").join(",")}) AND m.sent_at >= ?
      ${flaggedOnly ? "AND m.flagged = 1 AND m.dismissed = 0 AND m.issue_id IS NULL" : ""}
    ORDER BY m.sent_at DESC LIMIT 300`, ...ids, since);
}

function message(d: Deps, u: User, id: string) {
  const m = get<MessageRow>(d.db, `SELECT m.*, g.team_id, g.source, g.name AS group_name FROM chat_messages m
    JOIN chat_groups g ON g.id = m.group_id WHERE m.id = ?`, id);
  if (!m) throw new DomainError(404, "NOT_FOUND", "Message not found");
  assertTeamVisible(d.db, u, m.team_id);
  return m;
}

export function setFlag(d: Deps, u: User, id: string, p: { flagged?: boolean; dismissed?: boolean }) {
  const m = message(d, u, id);
  if (p.flagged !== undefined) run(d.db, "UPDATE chat_messages SET flagged = ? WHERE id = ?", p.flagged ? 1 : 0, m.id);
  if (p.dismissed !== undefined) run(d.db, "UPDATE chat_messages SET dismissed = ? WHERE id = ?", p.dismissed ? 1 : 0, m.id);
  d.bus.emit({ entity: "chat", id: m.id });
}

/** One click: the message becomes a tracked issue, owned by the team's TL (or the layer chosen). */
export function messageToIssue(d: Deps, u: User, id: string,
  o: { title?: string; category?: Category; severity?: Severity; layer?: Role } = {}) {
  const m = message(d, u, id);
  if (m.issue_id) throw new DomainError(409, "ALREADY_TRACKED", "This message is already a tracked issue");
  const guess = triage(m.text);
  const firstLine = m.text.split("\n")[0].replace(FLAG, "").trim();
  const issue = createIssue(d, u, {
    team_id: m.team_id,
    title: o.title?.trim() || (firstLine.length > 90 ? firstLine.slice(0, 87) + "…" : firstLine) || "Issue from chat",
    description: `From ${m.source === "telegram" ? "Telegram" : "Google Chat"} · ${m.group_name} · ${m.author}, ${m.sent_at.slice(0, 16).replace("T", " ")} UTC\n\n> ${m.text}`,
    category: o.category ?? guess.category,
    severity: o.severity ?? guess.severity,
    sla_related: guess.sla_related,
    source: m.source as "telegram" | "google_chat",
    source_ref: m.id,
    layer: o.layer ?? "TL",
  });
  run(d.db, "UPDATE chat_messages SET issue_id = ?, flagged = 1 WHERE id = ?", issue.id, m.id);
  d.bus.emit({ entity: "chat", id: m.id });
  return issue;
}
