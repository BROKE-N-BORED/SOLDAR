// One shared rule for turning a plain value into an engine Item.
//
// Trigger data (CLI --trigger-data, the API run endpoint) and Code node
// returns all accept the same two shapes: a plain object becomes the
// item's json, and an object with a json object becomes that item. The
// rule used to be written three times and could drift; it lives here now.

import type { Item } from './types.js';

/**
 * Turn one entry into an Item by the shared rule. Returns null when the
 * entry is not an object — the caller phrases its own error, since
 * trigger data and Code returns are explained differently.
 */
export function entryToItem(entry: unknown): Item | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (
    record.json !== null &&
    typeof record.json === 'object' &&
    !Array.isArray(record.json)
  ) {
    return { json: record.json as Record<string, unknown> };
  }
  // A plain object is treated as the item's json.
  return { json: record };
}
