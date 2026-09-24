import { Hono } from "hono";
import type { WfmPort } from "./ports/wfm.ts";
import type { Deps } from "./domain/issues.ts";
import { publicApi } from "./api/public-v1.ts";
import { internalApi } from "./api/internal.ts";
import { webhooks } from "./api/webhooks.ts";

export interface AppDeps extends Deps {
  wfm: WfmPort;
  apiTokens: string[];
  telegramSecret?: string;
  googleChatToken?: string;
}

export function createApp(d: AppDeps) {
  const app = new Hono();
  app.route("/api/ops/v1", publicApi(d));
  app.route("/webhooks", webhooks(d));
  app.route("/api", internalApi(d));
  app.get("/healthz", (c) => c.json({ ok: true, wfm: d.wfm.name }));
  return app;
}
