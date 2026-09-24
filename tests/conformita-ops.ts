/**
 * Conformity kit for ops.v1 — what anything claiming to speak `ops.v1` must pass.
 * Written against a plain `fetch`, so Nodo can run the same kit against its mock
 * and against a live Plancia (see docs/NODO-INTEGRATION.md).
 */
import { expect, it } from "vitest";
import * as C from "../server/contracts/ops.v1.ts";

export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export function conformitaOps(name: string, f: Fetch, opts: { token: string; now: () => Date }) {
  const auth = { authorization: `Bearer ${opts.token}` };
  const getJson = async (path: string) => {
    const res = await f(path, { headers: auth });
    return { status: res.status, body: await res.json() };
  };
  const fresh = (observed: string) =>
    expect(Math.abs(Date.parse(observed) - opts.now().getTime())).toBeLessThanOrEqual(60_000);

  it(`${name}: refuses calls without a valid token, with a coded body`, async () => {
    const res = await f("/api/ops/v1/issues");
    expect(res.status).toBe(401);
    expect(C.ErrorBody.parse(await res.json()).error.code).toBe("OPS-401-AUTH");
    const bad = await f("/api/ops/v1/issues", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it(`${name}: publishes a manifest with version and limits`, async () => {
    const { body } = await getJson("/api/ops/v1/manifest");
    expect(body.version).toBe(C.OPS_CONTRACT_VERSION);
    expect(body.limits.maxPageSize).toBe(C.OPS_LIMITS.maxPageSize);
    expect(Object.keys(body.methods).every((m) => m.startsWith("ops.v1."))).toBe(true);
  });

  it(`${name}: list_issues pages with an opaque cursor, no overlaps, nothing missed`, async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const { status, body } = await getJson(`/api/ops/v1/issues?limit=40${q}`);
      expect(status).toBe(200);
      const page = C.Page(C.Issue).parse(body);
      fresh(page.observed_at);
      expect(page.items.length).toBeLessThanOrEqual(40);
      for (const i of page.items) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 100);
    expect(pages).toBeGreaterThan(1);
    const all = C.Page(C.Issue).parse((await getJson(`/api/ops/v1/issues?limit=${C.OPS_LIMITS.maxPageSize}`)).body);
    expect(seen.size).toBeGreaterThanOrEqual(all.items.length);
  });

  it(`${name}: rejects bad input with OPS-400-INPUT`, async () => {
    for (const path of [
      `/api/ops/v1/issues?limit=${C.OPS_LIMITS.maxPageSize + 1}`,
      "/api/ops/v1/issues?status=whatever",
      "/api/ops/v1/issues?cursor=not-a-cursor",
      "/api/ops/v1/cost-rollup?from=2026-01-01&to=2026-09-01", // wider than maxRangeDays
      "/api/ops/v1/cost-rollup?from=2026-09-10&to=2026-09-01",
    ]) {
      const { status, body } = await getJson(path);
      expect(status, path).toBe(400);
      expect(C.ErrorBody.parse(body).error.code).toBe("OPS-400-INPUT");
    }
  });

  it(`${name}: get_issue returns the chain of owners and the events`, async () => {
    const list = C.Page(C.Issue).parse((await getJson("/api/ops/v1/issues?status=open&limit=5")).body);
    const { body } = await getJson(`/api/ops/v1/issues/${list.items[0].id}`);
    const detail = C.Envelope(C.IssueDetail).parse(body).data;
    expect(detail.chain.length).toBeGreaterThan(0);
    expect(detail.chain[0].how).toBe("raised");
    expect(detail.events[0].type).toBe("created");
    const missing = await getJson("/api/ops/v1/issues/does-not-exist");
    expect(missing.status).toBe(404);
  });

  it(`${name}: create_issue lands at TL with an owner, and refuses a repeated external_ref`, async () => {
    const campaigns = C.Page(C.Campaign).parse((await getJson("/api/ops/v1/campaigns")).body);
    const team = campaigns.items[0].teams[0];
    const payload = { team_id: team.id, title: "Raised from Nodo", category: "staffing", severity: "medium", external_ref: "nodo-123" };
    const post = () => f("/api/ops/v1/issues", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const res = await post();
    expect(res.status).toBe(201);
    const created = C.Envelope(C.Issue).parse(await res.json()).data;
    expect(created.layer).toBe("TL");
    expect(created.source).toBe("nodo");
    expect((await post()).status).toBe(409);
  });

  it(`${name}: staffing, cost rollup and handovers match the contract and are fresh`, async () => {
    const s = C.Page(C.StaffingLine).parse((await getJson("/api/ops/v1/staffing")).body);
    fresh(s.observed_at);
    expect(s.items.every((l) => l.gap === Math.max(0, l.required - l.present))).toBe(true);
    const r = C.Envelope(C.CostRollup).parse((await getJson("/api/ops/v1/cost-rollup?from=2026-08-25&to=2026-09-24")).body);
    expect(r.data.lines.length).toBeGreaterThan(0);
    const h = C.Page(C.Handover).parse((await getJson("/api/ops/v1/handovers?limit=3")).body);
    expect(h.items.length).toBeLessThanOrEqual(3);
    if (h.next_cursor) {
      const h2 = C.Page(C.Handover).parse((await getJson(`/api/ops/v1/handovers?limit=3&cursor=${encodeURIComponent(h.next_cursor)}`)).body);
      expect(h2.items.some((x) => h.items.some((y) => y.id === x.id))).toBe(false);
    }
  });

  it(`${name}: kpi_scorecard returns the hierarchy parent-first, with status per KPI`, async () => {
    const { status, body } = await getJson("/api/ops/v1/kpis?from=2026-09-17&to=2026-09-24");
    expect(status).toBe(200);
    const page = C.Page(C.ScorecardNode).parse(body);
    fresh(page.observed_at);
    expect(page.items[0].parent_id).toBeNull();
    const ids = new Set<string>();
    for (const n of page.items) {
      if (n.parent_id) expect(ids.has(n.parent_id)).toBe(true);
      ids.add(n.id);
    }
    expect(page.items[0].kpis.sl.rag).toMatch(/green|amber|red|none/);
    expect((await getJson("/api/ops/v1/kpis?from=2026-01-01&to=2026-09-01")).status).toBe(400);
  });
}
