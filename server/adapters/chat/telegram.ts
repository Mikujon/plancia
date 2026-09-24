import { z } from "zod";
import type { InboundMessage } from "../../ports/chat.ts";

// The subset of a Telegram Bot API `Update` we read (https://core.telegram.org/bots/api#update).
const Update = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    date: z.number(),
    chat: z.object({ id: z.number(), title: z.string().optional(), type: z.string() }),
    from: z.object({ first_name: z.string(), last_name: z.string().optional(), username: z.string().optional() }).optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
  }).optional(),
});

/** A Telegram webhook update → a message, or null for anything that isn't a group text. */
export function parseTelegramUpdate(body: unknown): InboundMessage | null {
  const u = Update.safeParse(body);
  if (!u.success || !u.data.message) return null;
  const m = u.data.message;
  const text = (m.text ?? m.caption ?? "").trim();
  if (!text) return null;
  const author = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") : "Unknown";
  const command = /^\/issue(@\w+)?\b/i.test(text);
  return {
    source: "telegram",
    group_external_id: String(m.chat.id),
    group_name: m.chat.title,
    message_external_id: String(m.message_id),
    author,
    text: command ? text.replace(/^\/issue(@\w+)?\s*/i, "") : text,
    sent_at: new Date(m.date * 1000).toISOString(),
    flagged_by_command: command,
  };
}
