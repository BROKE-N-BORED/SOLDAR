// Sandboxed JavaScript for the Code node, via isolated-vm.
//
// The code runs in its own V8 isolate: no filesystem, no network, no
// require, no process, no Node APIs at all — just the code, the `items`
// list, and plain JavaScript built-ins (JSON, Math, Array, ...). A bad
// script kills the isolate, never the server.
//
// Convention: the code is a function body. `return items.map(...)` returns
// new items. Returning nothing passes the input items through unchanged.

import ivm from 'isolated-vm';
import type { Item } from './types.js';

export interface SandboxOptions {
  /** Milliseconds before a runaway script is killed. Default 10,000. */
  timeoutMs?: number;
  /** Megabytes of heap for the isolate. Default 128. */
  memoryLimitMB?: number;
}

/** Turn whatever the script returned into a list of items. */
function coerceToItems(value: unknown): Item[] {
  const toItem = (entry: unknown, index: number): Item => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
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
    throw new Error(
      `Code returned something that is not an item at position ${index}. ` +
        'Return a list of items like [{ json: { ... } }] or plain objects like [{ name: "x" }].',
    );
  };

  if (Array.isArray(value)) return value.map(toItem);
  if (value !== null && typeof value === 'object') return [toItem(value, 0)];
  throw new Error(
    'Code must return a list of items, like [{ json: { ... } }]. ' +
      `It returned ${value === null ? 'null' : typeof value}.`,
  );
}

export async function runSandboxedCode(
  code: string,
  items: Item[],
  options: SandboxOptions = {},
): Promise<Item[]> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const memoryLimitMB = options.memoryLimitMB ?? 128;

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('items', new ivm.ExternalCopy(items).copyInto());

    // The result is stringified inside the isolate so it crosses back as a
    // plain string; undefined means "no return", which passes items through.
    const script = await isolate.compileScript(
      `const __result = (function () { ${code} })(); ` +
        `__result === undefined ? null : JSON.stringify(__result)`,
    );
    const raw = await script.run(context, { timeout: timeoutMs });
    if (raw === null) return items;
    const parsed: unknown = JSON.parse(raw as string);
    return coerceToItems(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Code node failed: ${message}`);
  } finally {
    isolate.dispose();
  }
}
