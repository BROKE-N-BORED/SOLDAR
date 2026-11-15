import { describe, expect, it } from 'vitest';
import type { Item, NodeContext } from '@soldar/engine';
import { setNode } from './definition.js';

function ctx(input: Item[], params: Record<string, unknown>): NodeContext {
  return {
    input,
    params,
    credentials: async () => {
      throw new Error('no credentials in Phase 1');
    },
    log: () => {},
    workflow: { id: 'wf', name: 'Test' },
  };
}

describe('set', () => {
  it('adds fields and keeps the incoming ones', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], {
        values: [
          { name: 'b', value: 2 },
          { name: 'c', value: 'hi' },
        ],
      }),
    );
    expect(out).toEqual({ main: [{ json: { a: 1, b: 2, c: 'hi' } }] });
  });

  it('overwrites an existing field', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], { values: [{ name: 'a', value: 99 }] }),
    );
    expect(out).toEqual({ main: [{ json: { a: 99 } }] });
  });

  it('keeps only the set fields when keepOnlySet is on', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], {
        values: [{ name: 'b', value: 2 }],
        keepOnlySet: true,
      }),
    );
    expect(out).toEqual({ main: [{ json: { b: 2 } }] });
  });

  it('passes items through unchanged with no values', async () => {
    const out = await setNode.execute(ctx([{ json: { a: 1 } }], { values: [] }));
    expect(out).toEqual({ main: [{ json: { a: 1 } }] });
  });

  it('skips rows with an empty name', async () => {
    const out = await setNode.execute(
      ctx([{ json: {} }], {
        values: [{ name: '', value: 1 }, { name: 'ok', value: 2 }],
      }),
    );
    expect(out).toEqual({ main: [{ json: { ok: 2 } }] });
  });
});
