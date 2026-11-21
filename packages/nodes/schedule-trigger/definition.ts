import type { NodeDefinition } from '@soldar/engine';

/**
 * Schedule Trigger — starts a run on a clock, using a cron pattern.
 * The node itself only passes the trigger data through; the server's
 * scheduler reads the cron pattern and starts the run when it fires.
 * The workflow must be Active for the schedule to run.
 */
export const scheduleTrigger: NodeDefinition = {
  type: 'schedule-trigger',
  displayName: 'Schedule Trigger',
  description: 'Starts a run on a schedule, like every day at 9 AM. The workflow must be Active.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  inputs: 0,
  outputs: ['main'],
  parameters: [
    {
      name: 'cron',
      displayName: 'Schedule (cron pattern)',
      type: 'string',
      required: true,
      default: '0 9 * * *',
      description:
        'Five fields: minute, hour, day of month, month, day of week. ' +
        'Examples: "0 9 * * *" runs every day at 9 AM. "0 * * * *" runs every hour. ' +
        '"*/15 * * * *" runs every 15 minutes. "0 9 * * 1" runs Mondays at 9 AM. ' +
        'A star means "every". Times are this computer\'s local time.',
    },
  ],
  async execute(ctx) {
    // The scheduler hands over one item saying when it fired; with no
    // data (a manual press of Run), one empty item starts the run.
    return { main: ctx.input.length > 0 ? ctx.input : [{ json: {} }] };
  },
};
