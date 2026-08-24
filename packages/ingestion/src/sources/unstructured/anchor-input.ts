/**
 * Shared anchor-input builder.
 *
 * Strategies need to derive the `AnchorDeriveInput` for a given
 * item. The input shape varies per strategy (some strategies
 * have the body, some have feed fields, some have neither) but
 * the construction pattern is the same: pull values from the
 * spec + the resolved item + the fetched payload.
 *
 * This module centralizes that construction so individual
 * strategies don't re-implement the same plumbing.
 */

import type { ResolvedItem } from "./strategy-registry.js";
import type { FetchItemOutput } from "./strategy-registry.js";
import type { UnstructuredSource } from "@outpost/shared";

import type { AnchorDeriveInput } from "./anchor/derive-anchor.js";

/**
 * Build the `AnchorDeriveInput` for a single item. Pulls feed
 * fields from `ResolvedItem.metadata` when present, falls back
 * to `null` for strategies that don't carry them.
 */
export function buildAnchorInput(
  source: UnstructuredSource,
  item: ResolvedItem,
  payload: FetchItemOutput | null,
): AnchorDeriveInput {
  return {
    itemUrl: item.url,
    itemBody: payload?.cleanedText ?? null,
    anchorPattern: source.anchor_pattern ?? null,
    feedFields: item.metadata,
  };
}
