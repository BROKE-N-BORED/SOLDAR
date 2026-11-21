// Scheduler unit tests: pattern validation and job bookkeeping against
// a scratch database. Patterns are per-minute so nothing fires here;
// the firing itself is covered end to end in automation.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStorage,
  type Storage,
  type Workflow,
  type WorkflowStore,
} from '@soldar/engine';
import { RunService } from './run-service.js';
import { SchedulerService, isValidCronPattern } from './scheduler.js';

function scheduledWorkflow(id: string, cron: unknown, active: boolean): Workflow {
  return {
    id,
    name: 'Scheduled',
    active,
    nodes: [
      {
        id: 'n1',
        type: 'schedule-trigger',
        name: 'Clock',
        position: [100, 100],
        parameters: { cron },
      },
      {
        id: 'n2',
        type: 'set',
        name: 'Stamp',
        position: [320, 100],
        parameters: { values: [{ name: 'ran', value: 'yes' }] },
      },
    ],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

describe('isValidCronPattern', () => {
  it('accepts ordinary five-field patterns and per-second six-field ones', () => {
    expect(isValidCronPattern('0 9 * * *')).toBe(true);
    expect(isValidCronPattern('*/15 * * * *')).toBe(true);
    expect(isValidCronPattern('* * * * * *')).toBe(true);
  });

  it('rejects words, blanks, wrong field counts, and non-strings', () => {
    expect(isValidCronPattern('banana')).toBe(false);
    expect(isValidCronPattern('')).toBe(false);
    expect(isValidCronPattern('0 9 * *')).toBe(false);
    expect(isValidCronPattern(42)).toBe(false);
    expect(isValidCronPattern(undefined)).toBe(false);
  });
});

describe('SchedulerService', () => {
  let dir: string;
  let storage: Storage & WorkflowStore;
  let scheduler: SchedulerService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-scheduler-test-'));
    storage = createStorage(join(dir, 'test.db'));
    scheduler = new SchedulerService(storage, new RunService(storage));
  });

  afterEach(() => {
    scheduler.stopAll();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers a job for an active workflow with a schedule', () => {
    storage.createWorkflow(scheduledWorkflow('wf_a', '0 9 * * *', true));
    scheduler.syncWorkflow('wf_a');
    expect(scheduler.jobCount('wf_a')).toBe(1);
  });

  it('registers nothing for an inactive workflow', () => {
    storage.createWorkflow(scheduledWorkflow('wf_b', '0 9 * * *', false));
    scheduler.syncWorkflow('wf_b');
    expect(scheduler.jobCount('wf_b')).toBe(0);
  });

  it('skips a stored schedule whose pattern does not parse, without throwing', () => {
    storage.createWorkflow(scheduledWorkflow('wf_c', 'banana', true));
    expect(() => scheduler.syncWorkflow('wf_c')).not.toThrow();
    expect(scheduler.jobCount('wf_c')).toBe(0);
  });

  it('removeWorkflow stops the jobs', () => {
    storage.createWorkflow(scheduledWorkflow('wf_d', '0 9 * * *', true));
    scheduler.syncWorkflow('wf_d');
    scheduler.removeWorkflow('wf_d');
    expect(scheduler.jobCount('wf_d')).toBe(0);
  });

  it('syncAll picks up active workflows already in storage (the restart path)', () => {
    storage.createWorkflow(scheduledWorkflow('wf_e', '0 9 * * *', true));
    storage.createWorkflow(scheduledWorkflow('wf_f', '0 9 * * *', false));
    scheduler.syncAll();
    expect(scheduler.jobCount('wf_e')).toBe(1);
    expect(scheduler.jobCount('wf_f')).toBe(0);
  });
});
