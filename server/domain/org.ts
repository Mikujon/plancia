import { all, get, type DB } from "../db.ts";
import { DomainError, type Campaign, type Client, type Floor, type Role, type Team, type User } from "./types.ts";

/**
 * The organisation is a reporting line, not a set of roles:
 *   COO → CSDM (one per client account) → Floor Manager → Team Leader → team.
 * Everything else follows from `users.manager_id`:
 * - what you can see is your own subtree;
 * - an issue that can't be solved goes to the owner's manager, never skipping a level.
 */
export const RANK: Record<Role, number> = { TL: 0, FM: 1, CSDM: 2, COO: 3 };
export const PARENT_ROLE: Record<Role, Role | null> = { TL: "FM", FM: "CSDM", CSDM: "COO", COO: null };

export const users = (db: DB) => all<User>(db, "SELECT * FROM users ORDER BY CASE role WHEN 'COO' THEN 0 WHEN 'CSDM' THEN 1 WHEN 'FM' THEN 2 ELSE 3 END, name");
export const clients = (db: DB) => all<Client>(db, "SELECT * FROM clients ORDER BY name");
export const campaigns = (db: DB) => all<Campaign>(db, "SELECT * FROM campaigns ORDER BY client_id, name");
export const floors = (db: DB) => all<Floor>(db, "SELECT * FROM floors ORDER BY name");
export const teams = (db: DB) => all<Team>(db, "SELECT * FROM teams ORDER BY name");

export function userById(db: DB, id: string): User {
  const u = get<User>(db, "SELECT * FROM users WHERE id = ?", id);
  if (!u) throw new DomainError(404, "NOT_FOUND", "User not found");
  return u;
}
export function teamById(db: DB, id: string): Team {
  const t = get<Team>(db, "SELECT * FROM teams WHERE id = ?", id);
  if (!t) throw new DomainError(404, "NOT_FOUND", "Team not found");
  return t;
}
export function campaignById(db: DB, id: string): Campaign {
  const c = get<Campaign>(db, "SELECT * FROM campaigns WHERE id = ?", id);
  if (!c) throw new DomainError(404, "NOT_FOUND", "Campaign not found");
  return c;
}

/** The manager chain above a person, nearest first. */
export function chainAbove(db: DB, userId: string): User[] {
  const out: User[] = [];
  const seen = new Set<string>([userId]);
  let cur = userById(db, userId);
  while (cur.manager_id && !seen.has(cur.manager_id)) {
    seen.add(cur.manager_id);
    cur = userById(db, cur.manager_id);
    out.push(cur);
  }
  return out;
}

/** True when `ancestorId` is `userId` or sits above them in the reporting line. */
export function isAtOrAbove(db: DB, ancestorId: string, userId: string): boolean {
  return ancestorId === userId || chainAbove(db, userId).some((u) => u.id === ancestorId);
}

/** Everyone below a person (not including them). */
export function subtree(db: DB, userId: string): User[] {
  return all<User>(db, `
    WITH RECURSIVE below(id) AS (
      SELECT id FROM users WHERE manager_id = ?
      UNION SELECT u.id FROM users u JOIN below b ON u.manager_id = b.id
    ) SELECT u.* FROM users u JOIN below b ON b.id = u.id`, userId);
}

/** The manager of a team's TL at a given role (TL itself for "TL"). */
export function ownerFor(db: DB, layer: Role, teamId: string): string {
  const t = teamById(db, teamId);
  if (layer === "TL") return t.tl_id;
  const up = chainAbove(db, t.tl_id).find((u) => u.role === layer);
  if (!up) throw new DomainError(409, "NO_MANAGER", `No ${layer} above the team leader of ${t.name}`);
  return up.id;
}

/** Your perimeter: the teams led by you or by anyone in your subtree. */
export function visibleTeamIds(db: DB, u: User): Set<string> {
  if (u.role === "COO" && !u.manager_id) return new Set(teams(db).map((t) => t.id));
  const leaders = new Set([u.id, ...subtree(db, u.id).map((x) => x.id)]);
  return new Set(teams(db).filter((t) => leaders.has(t.tl_id)).map((t) => t.id));
}

export function visibleCampaignIds(db: DB, u: User): Set<string> {
  const ids = visibleTeamIds(db, u);
  return new Set(teams(db).filter((t) => ids.has(t.id)).map((t) => t.campaign_id));
}

export function assertTeamVisible(db: DB, u: User, teamId: string) {
  if (!visibleTeamIds(db, u).has(teamId)) throw new DomainError(403, "FORBIDDEN", "Outside your perimeter");
}

export interface OrgNode {
  user: Pick<User, "id" | "name" | "role">;
  teams: Pick<Team, "id" | "name" | "campaign_id">[];
  children: OrgNode[];
}

/** The reporting tree from a person down, with the teams each TL leads. */
export function orgTree(db: DB, rootId: string): OrgNode {
  const people = users(db);
  const ts = teams(db);
  const build = (u: User): OrgNode => ({
    user: { id: u.id, name: u.name, role: u.role },
    teams: ts.filter((t) => t.tl_id === u.id).map((t) => ({ id: t.id, name: t.name, campaign_id: t.campaign_id })),
    children: people.filter((p) => p.manager_id === u.id).map(build),
  });
  return build(userById(db, rootId));
}

/** Teams under a node of the tree (a person's own teams and everything below). */
export function teamsUnder(node: OrgNode): string[] {
  return [...node.teams.map((t) => t.id), ...node.children.flatMap(teamsUnder)];
}
