import { describe, expect, it } from 'vitest';
import type { NodeContext } from '@soldar/engine';
import { manualTrigger } from './definition.js';

function ctx(input: NodeContext['input']): NodeContext {
  return {
    input,
    params: {},
    credentials: async () => {
      throw new Error('no credentials in Phase 1');
    },
    log: () => {},
    workflow: { id: 'wf', name: 'Test' },
  };
}

describe('manual-trigger', () => {
  it('passes trigger data through', async () => {
    const out = await manualTrigger.execute(ctx([{ json: { a: 1 } }]));
    expect(out).toEqual({ main: [{ json: { a: 1 } }] });
  });

  it('emits one empty item with no trigger data', async () => {
    const out = await manualTrigger.execute(ctx([]));
    expect(out).toEqual({ main: [{ json: {} }] });
  });

  it('declares no inputs and one main output', () => {
    expect(manualTrigger.inputs).toBe(0);
    expect(manualTrigger.outputs).toEqual(['main']);
  });
});
