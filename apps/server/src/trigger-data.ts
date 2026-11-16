// Normalize trigger data from an API body into engine Items. Each entry is
// either an item's json directly ({"name": "Ada"}) or a full item
// ({"json": {"name": "Ada"}}). Same rule as the CLI's --trigger-data.

import type { Item } from '@soldar/engine';

export function parseTriggerData(value: unknown): Item[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Trigger data entry ${index} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (
      record.json !== null &&
      typeof record.json === 'object' &&
      !Array.isArray(record.json)
    ) {
      return { json: record.json as Record<string, unknown> };
    }
    return { json: record };
  });
}
