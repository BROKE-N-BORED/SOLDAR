import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from './storage.js';

describe('storage', () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-storage-test-'));
    dbPath = join(dir, 'test.db');
    storage = createStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an execution and reads it back', () => {
    const created = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    expect(created.id).toMatch(/^exec_/);
    expect(created.status).toBe('running');
    expect(created.finishedAt).toBeNull();

    const read = storage.getExecution(created.id);
    expect(read).toEqual(created);
  });

  it('updates an execution to success with a finish time', () => {
    const created = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    storage.updateExecution(created.id, { status: 'success', finishedAt: 1500 });
    const read = storage.getExecution(created.id);
    expect(read?.status).toBe('success');
    expect(read?.finishedAt).toBe(1500);
  });

  it('stores steps and lists them per execution', () => {
    const created = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    storage.addStep({
      executionId: created.id,
      nodeId: 'n1',
      nodeName: 'Start',
      nodeType: 'manual-trigger',
      status: 'success',
      inputJson: JSON.stringify([{ json: {} }]),
      outputJson: JSON.stringify({ main: [{ json: { a: 1 } }] }),
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    });
    storage.addStep({
      executionId: created.id,
      nodeId: 'n2',
      nodeName: 'Boom',
      nodeType: 'set',
      status: 'error',
      inputJson: '[]',
      outputJson: '{}',
      error: 'something broke',
      startedAt: 1001,
      finishedAt: 1002,
    });

    const steps = storage.listSteps(created.id);
    expect(steps).toHaveLength(2);
    expect(steps[0].nodeName).toBe('Start');
    expect(steps[0].status).toBe('success');
    expect(steps[1].status).toBe('error');
    expect(steps[1].error).toBe('something broke');
    expect(JSON.parse(steps[0].outputJson)).toEqual({ main: [{ json: { a: 1 } }] });
  });

  it('returns undefined for an unknown execution', () => {
    expect(storage.getExecution('exec_nope')).toBeUndefined();
    expect(storage.listSteps('exec_nope')).toEqual([]);
  });

  it('persists across reopening the same file', () => {
    const created = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    storage.close();
    const reopened = createStorage(dbPath);
    expect(reopened.getExecution(created.id)?.workflowName).toBe('Hello');
    reopened.close();
    // Prevent afterEach from double-closing the original handle.
    storage = reopened;
  });
});
