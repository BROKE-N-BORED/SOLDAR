import { describe, expect, it } from 'vitest';
import type { Item, NodeContext } from '@soldar/engine';
import { ifNode, testCondition, type IfCondition } from './definition.js';

function ctx(input: Item[], params: Record<string, unknown>): NodeContext {
  return {
    input,
    params,
    credentials: async () => {
      throw new Error('no credentials in Phase 1');
    },
    log: () => {},
    workflow: { id: 'wf', name: 'Test' },
  };
}

describe('testCondition', () => {
  const cases: [IfCondition, boolean][] = [
    [{ left: 30, operator: 'equals', right: '30' }, true],
    [{ left: 30, operator: 'equals', right: 31 }, false],
    [{ left: 'a', operator: 'notEquals', right: 'b' }, true],
    [{ left: 'hello world', operator: 'contains', right: 'world' }, true],
    [{ left: 'hello', operator: 'contains', right: 'world' }, false],
    [{ left: ['a', 'b'], operator: 'contains', right: 'b' }, true],
    [{ left: 'hello', operator: 'notContains', right: 'world' }, true],
    [{ left: 10, operator: 'greaterThan', right: 5 }, true],
    [{ left: 5, operator: 'greaterThan', right: 10 }, false],
    [{ left: '10', operator: 'greaterThan', right: '9' }, true],
    [{ left: '9', operator: 'greaterThan', right: '10' }, false],
    [{ left: '10', operator: 'lessThan', right: '9' }, false],
    [{ left: '2.5', operator: 'greaterThanOrEqual', right: 2.5 }, true],
    [{ left: '10', operator: 'lessThanOrEqual', right: '9' }, false],
    [{ left: 'apple', operator: 'greaterThan', right: 'banana' }, false],
    [{ left: 3, operator: 'lessThanOrEqual', right: 3 }, true],
    [{ left: '', operator: 'isEmpty' }, true],
    [{ left: null, operator: 'isEmpty' }, true],
    [{ left: [], operator: 'isEmpty' }, true],
    [{ left: 'x', operator: 'isEmpty' }, false],
    [{ left: 'x', operator: 'isNotEmpty' }, true],
    [{ left: 'hello', operator: 'startsWith', right: 'he' }, true],
    [{ left: 'hello', operator: 'endsWith', right: 'lo' }, true],
  ];
  it.each(cases)('evaluates %j as %s', (condition, expected) => {
    expect(testCondition(condition)).toBe(expected);
  });

  it('throws on an unknown operator', () => {
    expect(() =>
      testCondition({ left: 1, operator: 'wat' as IfCondition['operator'], right: 1 }),
    ).toThrow('unknown operator "wat"');
  });
});

describe('if', () => {
  const item: Item = { json: { greeting: 'Hello there' } };

  it('sends the item out "true" when the condition holds', async () => {
    const out = await ifNode.execute(
      ctx([item], {
        conditions: [{ left: 'Hello there', operator: 'contains', right: 'Hello' }],
      }),
    );
    expect(out).toEqual({ true: [item], false: [] });
  });

  it('sends the item out "false" when the condition does not hold', async () => {
    const out = await ifNode.execute(
      ctx([item], {
        conditions: [{ left: 'Hello there', operator: 'contains', right: 'Goodbye' }],
      }),
    );
    expect(out).toEqual({ true: [], false: [item] });
  });

  it('ANDs conditions by default', async () => {
    const out = await ifNode.execute(
      ctx([item], {
        conditions: [
          { left: 'Hello there', operator: 'contains', right: 'Hello' },
          { left: 'Hello there', operator: 'contains', right: 'Goodbye' },
        ],
      }),
    );
    expect(out.false).toEqual([item]);
  });

  it('ORs conditions when combine is "any"', async () => {
    const out = await ifNode.execute(
      ctx([item], {
        combine: 'any',
        conditions: [
          { left: 'Hello there', operator: 'contains', right: 'Hello' },
          { left: 'Hello there', operator: 'contains', right: 'Goodbye' },
        ],
      }),
    );
    expect(out.true).toEqual([item]);
  });

  it('throws with no conditions', async () => {
    await expect(ifNode.execute(ctx([item], { conditions: [] }))).rejects.toThrow(
      'at least one condition',
    );
  });
});
