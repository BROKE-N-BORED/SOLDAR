import { describe, expect, it } from 'vitest';
import type { Item, NodeContext } from '@soldar/engine';
import { codeNode } from './definition.js';

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

describe('code', () => {
  it('runs code over all items at once', async () => {
    const out = await codeNode.execute(
      ctx([{ json: { n: 1 } }, { json: { n: 2 } }], {
        code: 'return items.map((i) => ({ json: { n: i.json.n * 10 } }));',
      }),
    );
    expect(out).toEqual({ main: [{ json: { n: 10 } }, { json: { n: 20 } }] });
  });

  it('passes input through when the code returns nothing', async () => {
    const input = [{ json: { n: 1 } }];
    const out = await codeNode.execute(ctx(input, { code: 'const x = 1;' }));
    expect(out).toEqual({ main: input });
  });

  it('reports sandbox errors plainly', async () => {
    await expect(
      codeNode.execute(ctx([{ json: {} }], { code: 'throw new Error("nope");' })),
    ).rejects.toThrow('Code node failed: nope');
  });

  it('declares allItems execution mode', () => {
    expect(codeNode.executeMode).toBe('allItems');
  });
});
