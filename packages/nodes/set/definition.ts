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
    const built: Record<string, unknown> = {};
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
