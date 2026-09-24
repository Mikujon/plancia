import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { Bus } from "./bus.ts";
import { isEmpty, openDb } from "./db.ts";
import { createApp, type AppDeps } from "./app.ts";
import { seed } from "./seed.ts";
import { MockWfmAdapter } from "./adapters/wfm/mock.ts";
import { HttpWfmAdapter } from "./adapters/wfm/http.ts";
import { requiredFor, raiseGapIssues } from "./domain/staffing.ts";
import { runAutoEscalation } from "./domain/issues.ts";
import { raiseKpiActions } from "./domain/analysis.ts";
import { systemClock } from "./domain/time.ts";

// Minimal .env loader, so `pnpm start` works without extra packages.
if (existsSync(".env"))
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }

const db = openDb();
if (isEmpty(db)) {
  seed(db);
  console.log("Seeded a fresh demo database.");
}

const wfm = process.env.WFM_BASE_URL
  ? new HttpWfmAdapter(process.env.WFM_BASE_URL, process.env.WFM_TOKEN)
  : new MockWfmAdapter(requiredFor(db));

const apiTokens = (process.env.PLANCIA_API_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!apiTokens.length) {
  apiTokens.push("dev-nodo-token");
  console.warn("PLANCIA_API_TOKENS not set — the public API accepts the dev token 'dev-nodo-token'.");
}

const deps: AppDeps = {
  db, bus: new Bus(), clock: systemClock, wfm, apiTokens,
  telegramSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "dev-telegram-secret",
  googleChatToken: process.env.GOOGLE_CHAT_WEBHOOK_TOKEN || "dev-gchat-token",
};

const app = createApp(deps);
if (existsSync("dist")) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

// Background jobs: pick-up / due-date escalation, KPI breaches → actions, RTA gap watcher.
const tick = async () => {
  try {
    const moved = runAutoEscalation(deps);
    if (moved.length) console.log(`auto-escalated ${moved.length} issue(s)`);
    const kpi = raiseKpiActions(deps);
    if (kpi.length) console.log(`opened ${kpi.length} action(s) from KPI breaches`);
    const opened = await raiseGapIssues(deps, wfm);
    if (opened.length) console.log(`opened ${opened.length} staffing issue(s) from RTA`);
  } catch (e) {
    console.error("job failed:", e instanceof Error ? e.message : e);
  }
};
setInterval(tick, 30_000);
void tick();

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Plancia API on http://localhost:${port}  (WFM feed: ${wfm.name})`));
