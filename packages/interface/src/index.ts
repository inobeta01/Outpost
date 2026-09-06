/**
 * @outpost/interface
 *
 * Agent interface layer. Per Architecture Review gap #4: this package
 * does TWO things with different consistency/state models, and the
 * diagram should call that out — MCP (stateless signed tool calls)
 * vs webhook dispatcher (stateful signed outbox).
 *
 * MCP tools (locked per Architecture):
 *   - get_entry(id)
 *   - list_changes(since?, source_id?, range?)
 *   - verify_entry(id, signature)
 *
 * Tool responses are SIGNED, not just data-at-rest — agents act on
 * what the tool returns, and that needs to be tied to the entry.
 *
 * NOTE: Placeholder.
 */

export const INTERFACE_VERSION = "0.0.0" as const;
