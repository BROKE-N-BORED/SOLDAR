import type { NodeDefinition } from '@soldar/engine';

interface SetValue {
  name: string;
  value: unknown;
}

/**
 * Set — build new fields (or overwrite existing ones) on each item.
 * Values may contain {{ }} expressions; the runner evaluates them per item
 * before this runs. With keepOnlySet, the output holds only the set fields.
 */
export const setNode: NodeDefinition = {
  type: 'set',
  displayName: 'Set',
  description: 'Build new fields, rename fields, or set fixed values on each item.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2" fill="currentColor" stroke="none"/></svg>',
  inputs: 1,
  outputs: ['main'],
  parameters: [
    {
      name: 'values',
      displayName: 'Values to set',
      type: 'keyValue',
      description: 'One row per field. The value may contain {{ }} expressions.',
      default: [],
    },
    {
      name: 'keepOnlySet',
      displayName: 'Keep only the set fields',
      type: 'boolean',
      description: 'When on, incoming fields are dropped and only the set fields remain.',
      default: false,
    },
  ],
  async execute(ctx) {
    const values = (Array.isArray(ctx.params.values) ? ctx.params.values : []) as SetValue[];
    // A null-prototype object: a field named __proto__ becomes a real field
    // instead of setting the prototype and vanishing from the output.
    const built: Record<string, unknown> = Object.create(null);
    for (const entry of values) {
      if (entry && typeof entry.name === 'string' && entry.name !== '') {
        built[entry.name] = entry.value;
      }
    }
    const keepOnly = ctx.params.keepOnlySet === true;
    return {
      main: ctx.input.map((item) => ({
        json: keepOnly ? { ...built } : { ...item.json, ...built },
      })),
    };
  },
};
