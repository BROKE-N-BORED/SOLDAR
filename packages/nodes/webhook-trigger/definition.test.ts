import { describe, expect, it } from 'vitest';
import type { NodeContext } from '@soldar/engine';
import { webhookTrigger } from './definition.js';

function ctx(input: NodeContext['input']): NodeContext {
  return {
    input,
    params: {},
    credentials: async () => {
      throw new Error('no credentials in tests');
    },
    log: () => {},
    workflow: { id: 'wf', name: 'Test' },
  };
}

describe('webhook-trigger', () => {
  it('passes the request item through', async () => {
    const out = await webhookTrigger.execute(ctx([{ json: { body: { hello: 'world' } } }]));
    expect(out).toEqual({ main: [{ json: { body: { hello: 'world' } } }] });
  });

  it('emits one empty item with no trigger data', async () => {
    const out = await webhookTrigger.execute(ctx([]));
    expect(out).toEqual({ main: [{ json: {} }] });
  });

  it('declares no inputs and one main output', () => {
    expect(webhookTrigger.inputs).toBe(0);
    expect(webhookTrigger.outputs).toEqual(['main']);
  });
});
