import type { NodeDefinition } from '@soldar/engine';

/** Manual Trigger — starts a run when you press Run. */
export const manualTrigger: NodeDefinition = {
  type: 'manual-trigger',
  displayName: 'Manual Trigger',
  description: 'Starts a run when you press Run.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>',
  inputs: 0,
  outputs: ['main'],
  parameters: [],
  async execute(ctx) {
    // Trigger data passes through; with no data, one empty item starts the run.
    return { main: ctx.input.length > 0 ? ctx.input : [{ json: {} }] };
  },
};
