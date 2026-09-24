import { describe, expect, it } from "vitest";
import { conformitaOps } from "./conformita-ops.ts";
import { makeTestApp, TOKEN } from "./helpers.ts";

describe("ops.v1 served by Plancia", () => {
  const t = makeTestApp();
  const f = async (path: string, init?: RequestInit) => t.app.request(path, init);
  conformitaOps("plancia", f, { token: TOKEN, now: t.now });

  it("never leaks internals in an error body", async () => {
    const res = await f("/api/ops/v1/issues/%27%20OR%201=1", { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(text).not.toMatch(/SELECT|sqlite|stack|at .*\.ts/i);
  });

  it("webhooks refuse calls without their secret", async () => {
    expect((await f("/webhooks/telegram", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await f("/webhooks/google-chat?token=wrong", { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await f("/webhooks/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "tg-secret", "content-type": "application/json" },
      body: JSON.stringify({ update_id: 5, message: { message_id: 9, date: 1790000000, chat: { id: -1001000000001, type: "supergroup" }, text: "#issue login loop" } }),
    });
    expect(await ok.json()).toMatchObject({ stored: true });
  });
});
