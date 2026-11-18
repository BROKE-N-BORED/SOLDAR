// CLI tests: exit codes, argument parsing, trigger data, help, bad usage.
// main() is called in-process with a faked process.argv; it signals a
// handled exit by throwing '__cli_exit__' after setting process.exitCode.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@soldar/engine';
import { main } from './cli.js';

const WORKFLOW: Workflow = {
  id: 'wf-1',
  name: 'Greet',
  active: false,
  nodes: [
    { id: 't1', type: 'manual-trigger', name: 'Start', position: [0, 0], parameters: {} },
    {
      id: 's1',
      type: 'set',
      name: 'Greet',
      position: [200, 0],
      parameters: { values: [{ name: 'greeting', value: '{{ $json.name }}' }] },
    },
  ],
  connections: [{ from: 't1', to: 's1' }],
};

const FAILING: Workflow = {
  ...WORKFLOW,
  id: 'wf-2',
  name: 'Boom',
  nodes: [
    { id: 't1', type: 'manual-trigger', name: 'Start', position: [0, 0], parameters: {} },
    {
      id: 'c1',
      type: 'code',
      name: 'Boom',
      position: [200, 0],
      parameters: { code: 'throw new Error("kaboom");' },
    },
  ],
  connections: [{ from: 't1', to: 'c1' }],
};

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origArgv = process.argv;
  const origExitCode = process.exitCode;
  process.argv = ['node', 'cli', ...argv];
  process.exitCode = undefined;
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi
    .spyOn(console, 'log')
    .mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  const errSpy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  let code: number;
  try {
    await main();
    code = process.exitCode ?? 0;
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__cli_exit__') throw err;
    code = process.exitCode ?? 0;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.argv = origArgv;
    process.exitCode = origExitCode;
  }
  return { code, out: logs.join('\n'), err: errors.join('\n') };
}

describe('cli', () => {
  let dir: string;
  let wfPath: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-cli-'));
    wfPath = join(dir, 'wf.json');
    writeFileSync(wfPath, JSON.stringify(WORKFLOW));
    dbPath = join(dir, 'runs.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints help and exits 0', async () => {
    const { code, out } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
  });

  it('prints help with no arguments and exits 0', async () => {
    const { code, out } = await runCli([]);
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
  });

  it('rejects an unknown command with exit 2', async () => {
    const { code, err } = await runCli(['frobnicate']);
    expect(code).toBe(2);
    expect(err).toContain('Unknown command "frobnicate"');
  });

  it('rejects run with no workflow file with exit 2', async () => {
    const { code, err } = await runCli(['run']);
    expect(code).toBe(2);
    expect(err).toContain('Missing workflow file');
  });

  it('rejects an unknown option with exit 2', async () => {
    const { code, err } = await runCli(['run', wfPath, '--bogus']);
    expect(code).toBe(2);
    expect(err).toContain('Unknown option "--bogus"');
  });

  it('--db does not swallow a following flag as its value', async () => {
    const { code, err } = await runCli(['run', wfPath, '--db', '--json']);
    expect(code).toBe(2);
    expect(err).toContain('--db needs a path');
  });

  it('--trigger-data does not swallow a following flag as its value', async () => {
    const { code, err } = await runCli(['run', wfPath, '--trigger-data', '--json']);
    expect(code).toBe(2);
    expect(err).toContain('--trigger-data needs a JSON value');
  });

  it('exits 1 when the workflow file cannot be read', async () => {
    const { code, err } = await runCli(['run', join(dir, 'missing.json'), '--db', dbPath]);
    expect(code).toBe(1);
    expect(err).toContain('Could not read');
  });

  it('exits 1 when the workflow file is not JSON', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{oops');
    const { code, err } = await runCli(['run', bad, '--db', dbPath]);
    expect(code).toBe(1);
    expect(err).toContain('Could not parse');
  });

  it('exits 1 when --trigger-data is not valid JSON', async () => {
    const { code, err } = await runCli([
      'run',
      wfPath,
      '--db',
      dbPath,
      '--trigger-data',
      'nope',
    ]);
    expect(code).toBe(1);
    expect(err).toContain('--trigger-data is not valid JSON');
  });

  it('exits 1 when a --trigger-data entry is not an object', async () => {
    const { code, err } = await runCli([
      'run',
      wfPath,
      '--db',
      dbPath,
      '--trigger-data',
      '[1]',
    ]);
    expect(code).toBe(1);
    expect(err).toContain('--trigger-data entry 0 is not an object');
  });

  it('runs a workflow, exits 0, and stores the run', async () => {
    const { code, out } = await runCli(['run', wfPath, '--db', dbPath]);
    expect(code).toBe(0);
    expect(out).toContain('Status: success');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('--json prints the full run result as JSON', async () => {
    const { code, out } = await runCli(['run', wfPath, '--db', dbPath, '--json']);
    expect(code).toBe(0);
    const result = JSON.parse(out) as { status: string; steps: unknown[] };
    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
  });

  it('passes --trigger-data to the trigger node', async () => {
    const { code, out } = await runCli([
      'run',
      wfPath,
      '--db',
      dbPath,
      '--trigger-data',
      '{"name":"Ada"}',
      '--json',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(out) as {
      steps: { output: { main: { json: { greeting: string } }[] } }[];
    };
    expect(result.steps[1].output.main[0].json.greeting).toBe('Ada');
  });

  it('exits 1 when the run fails', async () => {
    const failingPath = join(dir, 'failing.json');
    writeFileSync(failingPath, JSON.stringify(FAILING));
    const { code, out } = await runCli(['run', failingPath, '--db', dbPath]);
    expect(code).toBe(1);
    expect(out).toContain('Status: error');
    expect(out).toContain('kaboom');
  });
});
