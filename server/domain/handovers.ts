import { randomUUID } from "node:crypto";
import { all, get, run, tx, type DB } from "../db.ts";
import type { Deps } from "./issues.ts";
import { assertTeamVisible, visibleTeamIds } from "./org.ts";
import { iso } from "./time.ts";
import { DomainError, type User } from "./types.ts";

export interface HandoverRow {
  id: string; team_id: string; team_name: string; campaign_id: string; date: string; shift_id: string; shift_name: string;
  author_id: string; author_name: string; notes: string; headcount_note: string | null;
  acknowledged_by: string | null; acknowledged_name: string | null; acknowledged_at: string | null; created_at: string;
  issues: { id: string; ref: string; title: string; status: string; layer: string; severity: string }[];
}

function withIssues(db: DB, rows: Omit<HandoverRow, "issues">[]): HandoverRow[] {
  return rows.map((h) => ({
    ...h,
    issues: all(db, `SELECT i.id, i.ref, i.title, i.status, i.layer, i.severity FROM handover_issues hi
      JOIN issues i ON i.id = hi.issue_id WHERE hi.handover_id = ? ORDER BY i.ref`, h.id),
  }));
}

export function listHandovers(d: Deps, u: User, f: { team_id?: string; q?: string; from?: string; limit?: number } = {}): HandoverRow[] {
  const ids = [...visibleTeamIds(d.db, u)].filter((id) => !f.team_id || id === f.team_id);
  if (!ids.length) return [];
  const params: (string | number)[] = [...ids];
  let extra = "";
  if (f.q) { extra += " AND (h.notes LIKE ? OR IFNULL(h.headcount_note,'') LIKE ?)"; params.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.from) { extra += " AND h.date >= ?"; params.push(f.from); }
  params.push(Math.min(f.limit ?? 50, 500));
  const rows = all<Omit<HandoverRow, "issues">>(d.db, `
    SELECT h.*, t.name AS team_name, t.campaign_id, s.name AS shift_name, a.name AS author_name, k.name AS acknowledged_name
    FROM handovers h JOIN teams t ON t.id = h.team_id JOIN shifts s ON s.id = h.shift_id
    JOIN users a ON a.id = h.author_id LEFT JOIN users k ON k.id = h.acknowledged_by
    WHERE h.team_id IN (${ids.map(() => "?").join(",")}) ${extra}
    ORDER BY h.created_at DESC LIMIT ?`, ...params);
  return withIssues(d.db, rows);
}

export function createHandover(d: Deps, u: User,
  p: { team_id: string; shift_id: string; date: string; notes: string; headcount_note?: string; issue_ids?: string[] }) {
  assertTeamVisible(d.db, u, p.team_id);
  const id = randomUUID();
  const now = iso(d.clock());
  // By default every open issue of the team carries over, so nothing is lost at shift change.
  const issueIds = p.issue_ids ?? all<{ id: string }>(d.db,
    "SELECT id FROM issues WHERE team_id = ? AND status IN ('open','in_progress')", p.team_id).map((r) => r.id);
  tx(d.db, () => {
    run(d.db, `INSERT INTO handovers (id, team_id, date, shift_id, author_id, notes, headcount_note, created_at)
      VALUES (?,?,?,?,?,?,?,?)`, id, p.team_id, p.date, p.shift_id, u.id, p.notes.trim(), p.headcount_note?.trim() || null, now);
    for (const iid of issueIds) run(d.db, "INSERT OR IGNORE INTO handover_issues (handover_id, issue_id) VALUES (?,?)", id, iid);
  });
  d.bus.emit({ entity: "handover", id });
  return id;
}

export function acknowledgeHandover(d: Deps, u: User, id: string) {
  const h = get<{ team_id: string; author_id: string; acknowledged_at: string | null }>(d.db, "SELECT team_id, author_id, acknowledged_at FROM handovers WHERE id = ?", id);
  if (!h) throw new DomainError(404, "NOT_FOUND", "Handover not found");
  assertTeamVisible(d.db, u, h.team_id);
  if (h.acknowledged_at) throw new DomainError(409, "ALREADY_ACK", "Already acknowledged");
  if (h.author_id === u.id) throw new DomainError(409, "OWN_HANDOVER", "The incoming lead acknowledges, not the author");
  run(d.db, "UPDATE handovers SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?", u.id, iso(d.clock()), id);
  d.bus.emit({ entity: "handover", id });
}
