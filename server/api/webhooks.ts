import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { parseTelegramUpdate } from "../adapters/chat/telegram.ts";
import { parseGoogleChatEvent } from "../adapters/chat/google-chat.ts";
import { ingest } from "../domain/chat.ts";
import type { AppDeps } from "../app.ts";

const same = (a: string | undefined, b: string) =>
  a !== undefined && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Inbound chat. Platforms retry on non-2xx, so anything we won't store
 * (unmapped group, not a text) still answers 200.
 */
export function webhooks(d: AppDeps) {
  const app = new Hono();

  // Telegram: set the webhook with `secret_token`; Telegram echoes it in this header.
  app.post("/telegram", async (c) => {
    if (!d.telegramSecret || !same(c.req.header("x-telegram-bot-api-secret-token"), d.telegramSecret)) return c.body(null, 401);
    const m = parseTelegramUpdate(await c.req.json().catch(() => null));
    return c.json(m ? ingest(d, m) : { stored: false, reason: "ignored" });
  });

  // Google Chat: the app's HTTP endpoint URL carries ?token=…
  // Production should also verify the Google-signed bearer JWT on each call.
  app.post("/google-chat", async (c) => {
    if (!d.googleChatToken || !same(c.req.query("token"), d.googleChatToken)) return c.body(null, 401);
    const m = parseGoogleChatEvent(await c.req.json().catch(() => null));
    const r = m ? ingest(d, m) : { stored: false, reason: "ignored" };
    // Google Chat shows this text back in the space.
    return c.json(r.stored && m?.flagged_by_command ? { text: "Logged in Plancia — it will be picked up." } : {});
  });

  return app;
}
