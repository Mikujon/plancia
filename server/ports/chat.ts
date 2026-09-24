export type ChatSource = "google_chat" | "telegram";

/** A group-chat message, whatever platform it came from. */
export interface InboundMessage {
  source: ChatSource;
  group_external_id: string;
  group_name?: string;
  message_external_id: string;
  author: string;
  text: string;
  sent_at: string;
  /** The platform itself marked it (a /issue command, a slash command). */
  flagged_by_command?: boolean;
}
