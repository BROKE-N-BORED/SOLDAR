// Normalize trigger data from an API body into engine Items. Each entry is
// either an item's json directly ({"name": "Ada"}) or a full item
// ({"json": {"name": "Ada"}}). The entry rule is shared with the CLI and
// the Code sandbox through entryToItem, so the three can never drift.

import { entryToItem, type Item } from '@soldar/engine';

export function parseTriggerData(value: unknown): Item[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    const item = entryToItem(entry);
    if (item) return item;
    throw new Error(`Trigger data entry ${index} is not an object.`);
  });
}
