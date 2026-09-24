import { z } from "zod";
import type { InboundMessage } from "../../ports/chat.ts";

// The subset of a Google Chat app interaction event we read
// (https://developers.google.com/workspace/chat/api/reference/rest/v1/Event).
const Event = z.object({
  type: z.string(),
  eventTime: z.string().optional(),
  space: z.object({ name: z.string(), displayName: z.string().optional() }),
  message: z.object({
    name: z.string(),
    text: z.string().optional(),
    argumentText: z.string().optional(),
    createTime: z.string().optional(),
    sender: z.object({ displayName: z.string().optional() }).optional(),
    slashCommand: z.object({ commandId: z.string() }).optional(),
  }).optional(),
});

/** A Google Chat MESSAGE event → a message, or null for anything else. */
export function parseGoogleChatEvent(body: unknown): InboundMessage | null {
  const e = Event.safeParse(body);
  if (!e.success || e.data.type !== "MESSAGE" || !e.data.message) return null;
  const m = e.data.message;
  const text = (m.argumentText ?? m.text ?? "").trim();
  if (!text) return null;
  return {
    source: "google_chat",
    group_external_id: e.data.space.name,
    group_name: e.data.space.displayName,
    message_external_id: m.name,
    author: m.sender?.displayName ?? "Unknown",
    text,
    sent_at: m.createTime ?? e.data.eventTime ?? new Date().toISOString(),
    flagged_by_command: Boolean(m.slashCommand),
  };
}
