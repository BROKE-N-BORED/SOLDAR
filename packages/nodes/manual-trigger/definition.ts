import type { NodeDefinition } from '@soldar/engine';

/** Manual Trigger — starts a run when you press Run. */
export const manualTrigger: NodeDefinition = {
  type: 'manual-trigger',
  displayName: 'Manual Trigger',
  description: 'Starts a run when you press Run.',
  inputs: 0,
  outputs: ['main'],
  parameters: [],
  async execute(ctx) {
    // Trigger data passes through; with no data, one empty item starts the run.
    return { main: ctx.input.length > 0 ? ctx.input : [{ json: {} }] };
  },
};
