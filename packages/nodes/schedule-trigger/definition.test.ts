import { describe, expect, it } from 'vitest';
import type { NodeContext } from '@soldar/engine';
import { scheduleTrigger } from './definition.js';

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

describe('schedule-trigger', () => {
  it('passes the fired item through', async () => {
    const out = await scheduleTrigger.execute(ctx([{ json: { firedAt: '2026-11-21T14:00:00Z' } }]));
    expect(out).toEqual({ main: [{ json: { firedAt: '2026-11-21T14:00:00Z' } }] });
  });

  it('emits one empty item with no trigger data', async () => {
    const out = await scheduleTrigger.execute(ctx([]));
    expect(out).toEqual({ main: [{ json: {} }] });
  });

  it('declares no inputs, one main output, and a cron pattern defaulting to 9 AM daily', () => {
    expect(scheduleTrigger.inputs).toBe(0);
    expect(scheduleTrigger.outputs).toEqual(['main']);
    const cron = scheduleTrigger.parameters.find((p) => p.name === 'cron')!;
    expect(cron.default).toBe('0 9 * * *');
  });
});
