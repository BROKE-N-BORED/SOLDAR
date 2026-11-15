import { runSandboxedCode, type NodeDefinition } from '@soldar/engine';

/**
 * Code — JavaScript in the sandbox, items in / items out. The code runs in
 * an isolated-vm isolate with no filesystem, no network, and no require; a
 * 10-second timeout and a memory cap apply. Write `return items.map(...)`
 * to return new items; returning nothing passes the input through.
 */
export const codeNode: NodeDefinition = {
  type: 'code',
  displayName: 'Code',
  description: 'JavaScript in a sandbox, items in / items out.',
  inputs: 1,
  outputs: ['main'],
  parameters: [
    {
      name: 'code',
      displayName: 'Code',
      type: 'code',
      required: true,
      description:
        'JavaScript. `items` holds the incoming items; return a list of items.',
      default: 'return items;',
    },
  ],
  // The Code node needs the whole list at once, not one item at a time.
  executeMode: 'allItems',
  async execute(ctx) {
    const code = String(ctx.params.code ?? '');
    const items = await runSandboxedCode(code, ctx.input);
    return { main: items };
  },
};
