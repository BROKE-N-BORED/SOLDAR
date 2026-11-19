import type { NodeDefinition } from '@soldar/engine';

interface SetValue {
  name: string;
  value: unknown;
}

/**
 * A typed value that is plainly a number: an optional minus, digits with
 * no leading zeros (except "0" itself), and an optional decimal part.
 * "42", "3.5", "-2" qualify; "007", "12px", "1,000", ".5" do not.
 */
const NUMERIC_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * A literal value typed into the editor as "42" means the number 42, so a
 * clean numeric string becomes a number. Only literal values qualify: an
 * expression result that happens to look numeric stays the string it is,
 * because the user never typed it as a number. The raw (unevaluated)
 * settings say which is which; without them, the value itself is the only
 * evidence, and a {{ }} in it still marks it as an expression.
 */
function coerceLiteral(value: unknown, rawValue: unknown): unknown {
  if (typeof value !== 'string' || !NUMERIC_TEXT.test(value)) return value;
  const literal = typeof rawValue === 'string' ? rawValue : value;
  if (literal.includes('{{')) return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
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
    const rawValues = (
      Array.isArray(ctx.rawParams?.values) ? ctx.rawParams.values : []
    ) as SetValue[];
    // A null-prototype object: a field named __proto__ becomes a real field
    // instead of setting the prototype and vanishing from the output.
    const built: Record<string, unknown> = Object.create(null);
    values.forEach((entry, index) => {
      if (entry && typeof entry.name === 'string' && entry.name !== '') {
        built[entry.name] = coerceLiteral(entry.value, rawValues[index]?.value);
      }
    });
    const keepOnly = ctx.params.keepOnlySet === true;
    return {
      main: ctx.input.map((item) => ({
        json: keepOnly ? { ...built } : { ...item.json, ...built },
      })),
    };
  },
};
