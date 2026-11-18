import type { NodeDefinition } from '@soldar/engine';

export type IfOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'startsWith'
  | 'endsWith';

export interface IfCondition {
  /** Left side. May contain {{ }} expressions — the runner evaluates them
   *  per item before this runs, so by here it is a plain value. */
  left: unknown;
  operator: IfOperator;
  right?: unknown;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** A value as a number, when it plainly is one: real numbers, and strings
 *  that are only a number ("10", "-2.5"). Anything else is not numeric. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Compare two values: numerically when both sides are numbers (so "10"
 * beats "9", which alphabetical order gets wrong), alphabetically
 * otherwise. Returns -1, 0, or 1.
 */
function compareValues(left: unknown, right: unknown): number {
  const lNum = asNumber(left);
  const rNum = asNumber(right);
  if (lNum !== null && rNum !== null) {
    return lNum < rNum ? -1 : lNum > rNum ? 1 : 0;
  }
  const lStr = String(left ?? '');
  const rStr = String(right ?? '');
  return lStr < rStr ? -1 : lStr > rStr ? 1 : 0;
}

/** Evaluate one condition against already-evaluated left/right values. */
export function testCondition(condition: IfCondition): boolean {
  const { left, operator, right } = condition;
  switch (operator) {
    case 'equals':
      // Loose on purpose: {{ $json.age }} gives a number, a typed "30" is a
      // string, and the workflow author means the same thing.
      // eslint-disable-next-line eqeqeq
      return left == right;
    case 'notEquals':
      // eslint-disable-next-line eqeqeq
      return left != right;
    case 'contains':
      if (typeof left === 'string') return left.includes(String(right ?? ''));
      if (Array.isArray(left)) return left.includes(right);
      return false;
    case 'notContains':
      if (typeof left === 'string') return !left.includes(String(right ?? ''));
      if (Array.isArray(left)) return !left.includes(right);
      return true;
    case 'greaterThan':
      return compareValues(left, right) > 0;
    case 'lessThan':
      return compareValues(left, right) < 0;
    case 'greaterThanOrEqual':
      return compareValues(left, right) >= 0;
    case 'lessThanOrEqual':
      return compareValues(left, right) <= 0;
    case 'isEmpty':
      return isEmptyValue(left);
    case 'isNotEmpty':
      return !isEmptyValue(left);
    case 'startsWith':
      return typeof left === 'string' && left.startsWith(String(right ?? ''));
    case 'endsWith':
      return typeof left === 'string' && left.endsWith(String(right ?? ''));
    default:
      throw new Error(`IF node: unknown operator "${String(operator)}".`);
  }
}

/**
 * IF — true/false branch on a condition. Items go out of the "true" output
 * when the conditions hold, otherwise out of "false". The runner routes
 * each output along its own wires.
 */
export const ifNode: NodeDefinition = {
  type: 'if',
  displayName: 'IF',
  description: 'True/false branch on a condition.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 L21 12 L12 21 L3 12 Z"/><path d="M12 8 L16 12 L12 16"/><path d="M8 12 H12"/></svg>',
  inputs: 1,
  outputs: ['true', 'false'],
  parameters: [
    {
      name: 'conditions',
      displayName: 'Conditions',
      type: 'json',
      description:
        'A list of { left, operator, right }. Left and right may contain {{ }} expressions.',
      default: [],
    },
    {
      name: 'combine',
      displayName: 'Combine conditions with',
      type: 'options',
      options: [
        { label: 'AND (all must hold)', value: 'all' },
        { label: 'OR (any must hold)', value: 'any' },
      ],
      default: 'all',
    },
  ],
  async execute(ctx) {
    const conditions = (Array.isArray(ctx.params.conditions)
      ? ctx.params.conditions
      : []) as IfCondition[];
    if (conditions.length === 0) {
      throw new Error('IF node needs at least one condition.');
    }
    const combine = ctx.params.combine === 'any' ? 'any' : 'all';
    const held =
      combine === 'all'
        ? conditions.every(testCondition)
        : conditions.some(testCondition);
    return held ? { true: ctx.input, false: [] } : { true: [], false: ctx.input };
  },
};
