import { describe, expect, it } from 'vitest';
import type { Item, NodeContext } from '@soldar/engine';
import { setNode } from './definition.js';

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

function ctxWithRaw(
  input: Item[],
  params: Record<string, unknown>,
  rawParams: Record<string, unknown>,
): NodeContext {
  return { ...ctx(input, params), rawParams };
}

describe('set', () => {
  it('adds fields and keeps the incoming ones', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], {
        values: [
          { name: 'b', value: 2 },
          { name: 'c', value: 'hi' },
        ],
      }),
    );
    expect(out).toEqual({ main: [{ json: { a: 1, b: 2, c: 'hi' } }] });
  });

  it('overwrites an existing field', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], { values: [{ name: 'a', value: 99 }] }),
    );
    expect(out).toEqual({ main: [{ json: { a: 99 } }] });
  });

  it('keeps only the set fields when keepOnlySet is on', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], {
        values: [{ name: 'b', value: 2 }],
        keepOnlySet: true,
      }),
    );
    expect(out).toEqual({ main: [{ json: { b: 2 } }] });
  });

  it('passes items through unchanged with no values', async () => {
    const out = await setNode.execute(ctx([{ json: { a: 1 } }], { values: [] }));
    expect(out).toEqual({ main: [{ json: { a: 1 } }] });
  });

  it('skips rows with an empty name', async () => {
    const out = await setNode.execute(
      ctx([{ json: {} }], {
        values: [{ name: '', value: 1 }, { name: 'ok', value: 2 }],
      }),
    );
    expect(out).toEqual({ main: [{ json: { ok: 2 } }] });
  });

  it('keeps a field named __proto__ instead of dropping it', async () => {
    const out = await setNode.execute(
      ctx([{ json: { a: 1 } }], {
        values: [{ name: '__proto__', value: { polluted: true } }],
      }),
    );
    const json = out.main[0].json as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(json, '__proto__')).toBe(true);
    expect(json['__proto__']).toEqual({ polluted: true });
    const roundTripped = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(roundTripped, '__proto__')).toBe(true);
    expect(roundTripped['__proto__']).toEqual({ polluted: true });
    // And it must not pollute the global prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('turns clean numeric strings into numbers', async () => {
    const out = await setNode.execute(
      ctx([{ json: {} }], {
        values: [
          { name: 'int', value: '42' },
          { name: 'decimal', value: '3.5' },
          { name: 'negative', value: '-2' },
          { name: 'zero', value: '0' },
        ],
      }),
    );
    expect(out).toEqual({
      main: [{ json: { int: 42, decimal: 3.5, negative: -2, zero: 0 } }],
    });
  });

  it('leaves strings that are not clean numbers alone', async () => {
    const out = await setNode.execute(
      ctx([{ json: {} }], {
        values: [
          { name: 'leadingZeros', value: '007' },
          { name: 'withUnit', value: '12px' },
          { name: 'grouped', value: '1,000' },
          { name: 'noIntegerPart', value: '.5' },
          { name: 'trailingDot', value: '5.' },
          { name: 'plain', value: 'hello' },
        ],
      }),
    );
    expect(out).toEqual({
      main: [
        {
          json: {
            leadingZeros: '007',
            withUnit: '12px',
            grouped: '1,000',
            noIntegerPart: '.5',
            trailingDot: '5.',
            plain: 'hello',
          },
        },
      ],
    });
  });

  it('does not coerce an expression result that looks numeric', async () => {
    // The stored value is an expression; it evaluated to the string "42".
    // The user never typed a number, so the string stays a string.
    const out = await setNode.execute(
      ctxWithRaw(
        [{ json: {} }],
        { values: [{ name: 'code', value: '42' }] },
        { values: [{ name: 'code', value: '{{ $json.code }}' }] },
      ),
    );
    expect(out).toEqual({ main: [{ json: { code: '42' } }] });
  });

  it('coerces when the stored value is the same literal', async () => {
    const out = await setNode.execute(
      ctxWithRaw(
        [{ json: {} }],
        { values: [{ name: 'age', value: '42' }] },
        { values: [{ name: 'age', value: '42' }] },
      ),
    );
    expect(out).toEqual({ main: [{ json: { age: 42 } }] });
  });

  it('does not coerce a mixed template result', async () => {
    const out = await setNode.execute(
      ctxWithRaw(
        [{ json: {} }],
        { values: [{ name: 'label', value: '42' }] },
        { values: [{ name: 'label', value: '{{ $json.n }}' }] },
      ),
    );
    expect(out.main[0].json).toEqual({ label: '42' });
  });
});
