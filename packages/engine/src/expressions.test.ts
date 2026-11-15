import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  evaluateParameters,
  evaluateTemplate,
  ExpressionError,
  type ExpressionScope,
} from './expressions.js';
import type { Item } from './types.js';

function scope(json: Record<string, unknown>, nodes: Record<string, Item[]> = {}): ExpressionScope {
  return { item: { json }, nodeOutputs: new Map(Object.entries(nodes)) };
}

describe('evaluateExpression', () => {
  it('reads fields from $json', () => {
    expect(evaluateExpression('$json.name', scope({ name: 'Ada' }))).toBe('Ada');
    expect(evaluateExpression('$json.a.b.c', scope({ a: { b: { c: 42 } } }))).toBe(42);
  });

  it('reads $json with bracket access', () => {
    expect(evaluateExpression("$json['weird key']", scope({ 'weird key': 7 }))).toBe(7);
  });

  it('returns undefined for a missing field instead of crashing', () => {
    expect(evaluateExpression('$json.missing', scope({}))).toBeUndefined();
    expect(evaluateExpression('$json.missing || "fallback"', scope({}))).toBe('fallback');
  });

  it('reads another node through $node["Name"].json', () => {
    const s = scope({}, { Greet: [{ json: { greeting: 'hi' } }] });
    expect(evaluateExpression('$node["Greet"].json.greeting', s)).toBe('hi');
    expect(evaluateExpression('$node["Greet"].items.length', s)).toBe(1);
  });

  it('errors on an unknown node name', () => {
    expect(() => evaluateExpression('$node["Nope"].json', scope({}))).toThrow(
      'Unknown node "Nope"',
    );
  });

  it('does basic math', () => {
    expect(evaluateExpression('$json.a + $json.b * 2', scope({ a: 1, b: 3 }))).toBe(7);
    expect(evaluateExpression('($json.a + $json.b) * 2', scope({ a: 1, b: 3 }))).toBe(8);
    expect(evaluateExpression('$json.a % 3', scope({ a: 10 }))).toBe(1);
    expect(evaluateExpression('-$json.a', scope({ a: 5 }))).toBe(-5);
  });

  it('does string concatenation with +', () => {
    expect(evaluateExpression('$json.first + " " + $json.last', scope({ first: 'Ada', last: 'L' }))).toBe(
      'Ada L',
    );
  });

  it('does comparisons and logic', () => {
    expect(evaluateExpression('$json.a > 5', scope({ a: 9 }))).toBe(true);
    expect(evaluateExpression('$json.a === 9', scope({ a: 9 }))).toBe(true);
    expect(evaluateExpression('$json.a !== 9', scope({ a: 9 }))).toBe(false);
    expect(evaluateExpression('$json.a > 5 && $json.b < 2', scope({ a: 9, b: 1 }))).toBe(true);
    expect(evaluateExpression('!$json.flag', scope({ flag: false }))).toBe(true);
  });

  it('does ternaries', () => {
    expect(evaluateExpression('$json.a > 5 ? "big" : "small"', scope({ a: 9 }))).toBe('big');
    expect(evaluateExpression('$json.a > 5 ? "big" : "small"', scope({ a: 2 }))).toBe('small');
  });

  it('does string helpers', () => {
    expect(evaluateExpression('$json.name.toUpperCase()', scope({ name: 'ada' }))).toBe('ADA');
    expect(evaluateExpression('$json.name.toLowerCase()', scope({ name: 'ADA' }))).toBe('ada');
    expect(evaluateExpression('$json.name.trim()', scope({ name: '  ada  ' }))).toBe('ada');
    expect(evaluateExpression('$json.name.length', scope({ name: 'ada' }))).toBe(3);
    expect(evaluateExpression('$json.text.includes("wor")', scope({ text: 'world' }))).toBe(true);
    expect(evaluateExpression('$json.csv.split(",")', scope({ csv: 'a,b' }))).toEqual(['a', 'b']);
  });

  it('does Math helpers', () => {
    expect(evaluateExpression('Math.max($json.a, $json.b)', scope({ a: 2, b: 5 }))).toBe(5);
    expect(evaluateExpression('Math.floor($json.a)', scope({ a: 2.9 }))).toBe(2);
  });

  it('does type conversions', () => {
    expect(evaluateExpression('Number($json.n)', scope({ n: '42' }))).toBe(42);
    expect(evaluateExpression('String($json.n)', scope({ n: 42 }))).toBe('42');
  });

  it('supports literals', () => {
    expect(evaluateExpression('42', scope({}))).toBe(42);
    expect(evaluateExpression('"hello"', scope({}))).toBe('hello');
    expect(evaluateExpression('true', scope({}))).toBe(true);
    expect(evaluateExpression('null', scope({}))).toBeNull();
  });

  it('rejects unknown names with a plain error', () => {
    expect(() => evaluateExpression('foo', scope({}))).toThrow('Unknown name "foo"');
  });

  it('rejects non-whitelisted methods', () => {
    expect(() => evaluateExpression('$json.name.constructor', scope({ name: 'x' }))).not.toThrow();
    expect(() => evaluateExpression('$json.name.repeat(2)', scope({ name: 'x' }))).toThrow(
      'not available on strings',
    );
  });

  it('rejects broken syntax with the expression in the message', () => {
    expect(() => evaluateExpression('$json.a +', scope({ a: 1 }))).toThrow(ExpressionError);
    expect(() => evaluateExpression('$json.a +', scope({ a: 1 }))).toThrow('{{ $json.a + }}');
  });
});

describe('evaluateTemplate', () => {
  it('returns the raw value when the whole string is one expression', () => {
    expect(evaluateTemplate('{{ $json.n }}', scope({ n: 42 }))).toBe(42);
    expect(evaluateTemplate('{{ $json.flag }}', scope({ flag: true }))).toBe(true);
    expect(evaluateTemplate('{{ $json.obj }}', scope({ obj: { a: 1 } }))).toEqual({ a: 1 });
  });

  it('interpolates expressions inside a string', () => {
    expect(
      evaluateTemplate('Hello {{ $json.name }}, you are {{ $json.age }}.', scope({ name: 'Ada', age: 36 })),
    ).toBe('Hello Ada, you are 36.');
  });

  it('leaves plain strings alone', () => {
    expect(evaluateTemplate('no expressions here', scope({}))).toBe('no expressions here');
  });

  it('renders missing values as empty strings inside text', () => {
    expect(evaluateTemplate('x{{ $json.missing }}y', scope({}))).toBe('xy');
  });
});

describe('evaluateParameters', () => {
  it('evaluates nested strings, arrays, and objects', () => {
    const params = evaluateParameters(
      {
        plain: 'static',
        one: '{{ $json.a }}',
        nested: { two: 'got {{ $json.b }}' },
        list: ['{{ $json.a }}', 5],
      },
      scope({ a: 1, b: 2 }),
    );
    expect(params).toEqual({
      plain: 'static',
      one: 1,
      nested: { two: 'got 2' },
      list: [1, 5],
    });
  });
});
