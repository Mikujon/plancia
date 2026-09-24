import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { createApp, type AppDeps } from "../server/app.ts";
import { seed } from "../server/seed.ts";
import { MockWfmAdapter } from "../server/adapters/wfm/mock.ts";
import { requiredFor } from "../server/domain/staffing.ts";

export const TOKEN = "test-token";

/** A fresh in-memory Plancia with seeded data and a clock the test controls. */
export function makeTestApp(start = new Date("2026-09-24T10:30:00.000Z")) {
  let now = start;
  const clock = () => now;
  const db = openDb(":memory:");
  seed(db, start);
  const deps: AppDeps = {
    db, bus: new Bus(), clock, wfm: new MockWfmAdapter(requiredFor(db), { now: clock }),
    apiTokens: [TOKEN], telegramSecret: "tg-secret", googleChatToken: "gc-token",
  };
  return {
    deps,
    app: createApp(deps),
    advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); },
    now: () => now,
  };
}
