import { describe, expect, it } from 'vitest';
import { runSandboxedCode } from './sandbox.js';
import type { Item } from './types.js';

const items: Item[] = [{ json: { n: 1 } }, { json: { n: 2 } }];

describe('runSandboxedCode', () => {
  it('runs code and returns new items', async () => {
    const out = await runSandboxedCode(
      'return items.map((item) => ({ json: { doubled: item.json.n * 2 } }));',
      items,
    );
    expect(out).toEqual([{ json: { doubled: 2 } }, { json: { doubled: 4 } }]);
  });

  it('passes input through when the code returns nothing', async () => {
    const out = await runSandboxedCode('const x = 1 + 1;', items);
    expect(out).toEqual(items);
  });

  it('wraps plain objects into items', async () => {
    const out = await runSandboxedCode('return [{ name: "ada" }];', items);
    expect(out).toEqual([{ json: { name: 'ada' } }]);
  });

  it('wraps a single object into one item', async () => {
    const out = await runSandboxedCode('return { json: { done: true } };', items);
    expect(out).toEqual([{ json: { done: true } }]);
  });

  it('rejects code that returns a non-item', async () => {
    await expect(runSandboxedCode('return 42;', items)).rejects.toThrow(
      'must return a list of items',
    );
  });

  it('reports a thrown error with its message', async () => {
    await expect(runSandboxedCode('throw new Error("boom");', items)).rejects.toThrow(
      'boom',
    );
  });

  it('has no require, process, or filesystem access', async () => {
    await expect(
      runSandboxedCode('return require("node:fs");', items),
    ).rejects.toThrow('require is not defined');
    await expect(runSandboxedCode('return process.version;', items)).rejects.toThrow(
      'process is not defined',
    );
  });

  it('kills a runaway loop at the timeout', async () => {
    await expect(
      runSandboxedCode('while (true) {}', items, { timeoutMs: 300 }),
    ).rejects.toThrow('timed out');
  });

  it('kills a script that blows past the memory cap', async () => {
    await expect(
      runSandboxedCode(
        'const a = []; while (true) a.push(new Array(100000).fill(0));',
        items,
        { memoryLimitMB: 8, timeoutMs: 10000 },
      ),
    ).rejects.toThrow('memory limit');
  }, 15000);

  it('provides $json as the first item\'s data', async () => {
    const out = await runSandboxedCode(
      'return [{ json: { doubled: $json.n * 2 } }];',
      items,
    );
    expect(out).toEqual([{ json: { doubled: 2 } }]);
  });

  it('provides $input.all() and $input.first()', async () => {
    const out = await runSandboxedCode(
      'return $input.all().map((item) => ({ json: { n: item.json.n + 10 } }));',
      items,
    );
    expect(out).toEqual([{ json: { n: 11 } }, { json: { n: 12 } }]);
    const first = await runSandboxedCode('return [$input.first()];', items);
    expect(first).toEqual([{ json: { n: 1 } }]);
  });

  it('$json is an empty object with no items', async () => {
    const out = await runSandboxedCode(
      'return [{ json: { keys: Object.keys($json).length } }];',
      [],
    );
    expect(out).toEqual([{ json: { keys: 0 } }]);
  });

  it('can use plain JavaScript built-ins', async () => {
    const out = await runSandboxedCode(
      'return items.map((i) => ({ json: { upper: String(i.json.n), max: Math.max(1, 2) } }));',
      items,
    );
    expect(out).toEqual([
      { json: { upper: '1', max: 2 } },
      { json: { upper: '2', max: 2 } },
    ]);
  });
});
