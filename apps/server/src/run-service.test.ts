// RunService tests: the two-run cap, cancelling a run, and waiting for
// runs to finish at shutdown.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage, type Workflow } from '@soldar/engine';
import { RunService, RunServiceBusyError } from './run-service.js';

const SLOW_CODE =
  'let x = 0; for (let i = 0; i < 200000000; i++) x += i; return items;';

function slowWorkflow(id: string): Workflow {
  return {
    id,
    name: 'Slow',
    active: false,
    nodes: [
      { id: 'n1', type: 'manual-trigger', name: 'Start', position: [0, 0], parameters: {} },
      {
        id: 'n2',
        type: 'code',
        name: 'Slow code',
        position: [200, 0],
        parameters: { code: SLOW_CODE },
      },
    ],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

describe('RunService', () => {
  let dir: string;
  let storage: Storage;
  let runs: RunService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-runservice-test-'));
    storage = createStorage(join(dir, 'test.db'));
    runs = new RunService(storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a third concurrent run with a plain error', async () => {
    const first = await runs.start(slowWorkflow('wf_1'));
    const second = await runs.start(slowWorkflow('wf_2'));
    expect(runs.activeCount()).toBe(2);
    await expect(runs.start(slowWorkflow('wf_3'))).rejects.toBeInstanceOf(
      RunServiceBusyError,
    );
    await expect(runs.start(slowWorkflow('wf_3'))).rejects.toThrow(
      'Two runs are already going',
    );
    // Clean up: cancel both so the test process can exit promptly.
    expect(runs.cancel(first)).toBe(true);
    expect(runs.cancel(second)).toBe(true);
    await runs.waitForIdle();
    expect(runs.activeCount()).toBe(0);
  }, 30000);

  it('cancels a run in flight and records it as stopped', async () => {
    const executionId = await runs.start(slowWorkflow('wf_1'));
    expect(runs.cancel(executionId)).toBe(true);
    expect(runs.cancel('exec_nope')).toBe(false);
    await runs.waitForIdle();
    const execution = storage.getExecution(executionId);
    expect(execution?.status).toBe('error');
    expect(execution?.error).toBe('Run stopped.');
    // Once the run has landed, there is nothing left to cancel.
    expect(runs.cancel(executionId)).toBe(false);
  }, 30000);

  it('waitForIdle returns at once when nothing is running', async () => {
    await runs.waitForIdle(100);
    expect(runs.activeCount()).toBe(0);
  });
});
