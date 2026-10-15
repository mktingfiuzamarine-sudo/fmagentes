export type ReplyGate = "read-only" | "assume-first" | "warn-other-owner" | "ok";

/** Advisory assignment: only handoffs take replies; others get a confirmation first. */
export function replyGate(
  conversation: { status: string; assignedTo: { id: string } | null },
  meId: string,
): ReplyGate {
  if (conversation.status !== "awaiting_human") return "read-only";
  if (!conversation.assignedTo) return "assume-first";
  return conversation.assignedTo.id === meId ? "ok" : "warn-other-owner";
}
