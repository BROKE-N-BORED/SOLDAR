import type { NodeDefinition } from '@soldar/engine';

/**
 * Webhook Trigger — starts a run when a request arrives at the
 * workflow's own web address. The node passes the request data
 * through; the server's webhook route does the receiving. The
 * workflow must be Active for the address to answer.
 */
export const webhookTrigger: NodeDefinition = {
  type: 'webhook-trigger',
  displayName: 'Webhook Trigger',
  description: 'Starts a run when a request arrives at this workflow\'s web address. The workflow must be Active.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  inputs: 0,
  outputs: ['main'],
  parameters: [
    {
      name: 'path',
      displayName: 'Address ending',
      type: 'string',
      default: '',
      description:
        'The last part of the web address that starts this workflow: the ' +
        '"abc123" in /webhook/abc123. Leave it empty and Soldar makes one ' +
        'up when you save. Use only letters, numbers, dashes, and ' +
        'underscores. The workflow only answers while it is Active.',
    },
  ],
  async execute(ctx) {
    // The webhook route hands over one item carrying the request; with
    // no data (a manual press of Run), one empty item starts the run.
    return { main: ctx.input.length > 0 ? ctx.input : [{ json: {} }] };
  },
};
