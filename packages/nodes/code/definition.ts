import { runSandboxedCode, type NodeDefinition } from '@soldar/engine';

/**
 * Code — JavaScript in the sandbox, items in / items out. The code runs in
 * an isolated-vm isolate with no filesystem, no network, and no require; a
 * 10-second timeout and a memory cap apply. Write `return items.map(...)`
 * to return new items; returning nothing passes the input through. `$json`
 * is the first item's data, `$input.all()` returns every item.
 */
export const codeNode: NodeDefinition = {
  type: 'code',
  displayName: 'Code',
  description: 'JavaScript in a sandbox, items in / items out.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  inputs: 1,
  outputs: ['main'],
  parameters: [
    {
      name: 'code',
      displayName: 'Code',
      type: 'code',
      required: true,
      description:
        'JavaScript. `items` holds the incoming items; `$json` is the first item\'s data and `$input.all()` returns all items. Return a list of items.',
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
