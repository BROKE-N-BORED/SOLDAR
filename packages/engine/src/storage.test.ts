import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage, type WorkflowStore } from './storage.js';
import type { Workflow } from './types.js';

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

describe('workflow storage', () => {
  let dir: string;
  let storage: Storage & WorkflowStore;

  const sample = (overrides: Partial<Workflow> = {}): Workflow => ({
    id: 'wf_1',
    name: 'Hello',
    active: false,
    nodes: [
      {
        id: 'n1',
        type: 'manual-trigger',
        name: 'Start',
        position: [100, 100],
        parameters: {},
      },
    ],
    connections: [],
    ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-workflow-test-'));
    storage = createStorage(join(dir, 'test.db'));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a workflow and reads it back', () => {
    const created = storage.createWorkflow(sample());
    expect(created.id).toBe('wf_1');
    expect(created.name).toBe('Hello');
    expect(JSON.parse(created.dataJson)).toEqual(sample());

    const read = storage.getWorkflow('wf_1');
    expect(read).toEqual(created);
  });

  it('lists workflows newest-first and updates one', () => {
    storage.createWorkflow(sample());
    storage.createWorkflow(sample({ id: 'wf_2', name: 'Second' }));
    const listed = storage.listWorkflows();
    expect(listed).toHaveLength(2);
    expect(listed[0].id).toBe('wf_2');

    const updated = storage.updateWorkflow('wf_1', sample({ name: 'Renamed' }));
    expect(updated?.name).toBe('Renamed');
    expect(JSON.parse(updated!.dataJson).name).toBe('Renamed');
    expect(storage.updateWorkflow('wf_nope', sample())).toBeUndefined();
  });

  it('toggles active in the column and in the stored JSON', () => {
    storage.createWorkflow(sample());
    const toggled = storage.setWorkflowActive('wf_1', true);
    expect(toggled?.active).toBe(true);
    expect(JSON.parse(toggled!.dataJson).active).toBe(true);
    expect(storage.setWorkflowActive('wf_nope', true)).toBeUndefined();
  });

  it('deletes a workflow', () => {
    storage.createWorkflow(sample());
    storage.deleteWorkflow('wf_1');
    expect(storage.getWorkflow('wf_1')).toBeUndefined();
    expect(storage.listWorkflows()).toEqual([]);
  });

  it('lists executions newest-first, optionally per workflow', () => {
    const a = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    const b = storage.createExecution({
      workflowId: 'wf_2',
      workflowName: 'Other',
      trigger: 'manual',
      startedAt: 2000,
    });
    const all = storage.listExecutions();
    expect(all.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(storage.listExecutions('wf_1').map((e) => e.id)).toEqual([a.id]);
    expect(storage.listExecutions('wf_1', 1)).toHaveLength(1);
  });
});
