// Stateful transformer: @openai/codex-sdk ThreadEvent → canonical stream-json frame(s).
//
// The Codex SDK emits full accumulated text on each agent_message update rather
// than deltas, so we track the last-seen character offset per item id to compute
// the delta ourselves.
//
// Handled events:
//   item.started / item.updated  { item: { type:"agent_message", id, text } }
//     → assistant frame with the NEW delta text (enables streaming TTFF parity
//       with claude-code; translateFrame handles assistant frames immediately)
//   item.completed               { item: { type:"agent_message", id, text } }
//     → skipped; all text already emitted via item.started/updated deltas
//
// All other events are ignored (forward-compatible).
export function createEventTransformer() {
  const textPositions = new Map(); // item.id → character offset of last emitted delta

  return function eventToFrames(event, { sessionId, model }) {
    if (!event || typeof event !== "object") return [];

    switch (event.type) {
      case "item.started":
      case "item.updated": {
        const item = event.item;
        if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
        const prev = textPositions.get(item.id) ?? 0;
        const delta = item.text.slice(prev);
        if (!delta) return [];
        textPositions.set(item.id, item.text.length);
        // Emit as assistant frame so translateFrame forwards it immediately as
        // agent.message — gives codex streaming TTFF instead of waiting for
        // item.completed (which only fires at end of full response).
        return [{ type: "assistant", message: { model, content: [{ type: "text", text: delta }] }, parent_tool_use_id: null }];
      }

      case "item.completed": {
        const item = event.item;
        if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
        // Emit any text not yet sent by item.started/updated deltas.
        // For SDKs that skip intermediate updates (short responses), this
        // emits the full text. For fully-streamed responses, remaining === "".
        const prev = textPositions.get(item.id) ?? 0;
        const remaining = item.text.slice(prev);
        if (!remaining) return [];
        return [{ type: "assistant", message: { model, content: [{ type: "text", text: remaining }] }, parent_tool_use_id: null }];
      }

      default:
        return [];
    }
  };
}
