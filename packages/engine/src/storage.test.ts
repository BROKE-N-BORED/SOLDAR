import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

  it('lists steps in run order, not insertion order', () => {
    const created = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    const step = (nodeName: string, startedAt: number) => ({
      executionId: created.id,
      nodeId: nodeName,
      nodeName,
      nodeType: 'set',
      status: 'success' as const,
      inputJson: '[]',
      outputJson: '{}',
      error: null,
      startedAt,
      finishedAt: startedAt + 1,
    });
    storage.addStep(step('third', 3000));
    storage.addStep(step('first', 1000));
    storage.addStep(step('second', 2000));
    expect(storage.listSteps(created.id).map((s) => s.nodeName)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('throws a plain error for a damaged stored row', () => {
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO executions (id, workflow_id, workflow_name, status, trigger, started_at, finished_at, error)
         VALUES ('exec_bad', 'wf_1', 'Hello', 'bogus', 'manual', 1000, NULL, NULL)`,
      )
      .run();
    raw.close();
    expect(() => storage.getExecution('exec_bad')).toThrow(
      'Stored run is damaged: unknown status "bogus".',
    );
  });

  it('migrations create the indexes and re-run cleanly on reopen', () => {
    const raw = new Database(dbPath);
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      'idx_execution_steps_execution_id',
      'idx_executions_started_at',
      'idx_executions_workflow_id',
    ]);
    const applied = raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    expect(applied.map((r) => r.version)).toEqual([1, 2]);
    raw.close();

    storage.close();
    const reopened = createStorage(dbPath);
    expect(reopened.listExecutions()).toEqual([]);
    reopened.close();
    // Prevent afterEach from double-closing the original handle.
    storage = reopened;
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

  it('deleting a workflow deletes its runs and steps', () => {
    storage.createWorkflow(sample());
    storage.createWorkflow(sample({ id: 'wf_2', name: 'Other' }));
    const doomed = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    const kept = storage.createExecution({
      workflowId: 'wf_2',
      workflowName: 'Other',
      trigger: 'manual',
      startedAt: 2000,
    });
    storage.addStep({
      executionId: doomed.id,
      nodeId: 'n1',
      nodeName: 'Start',
      nodeType: 'manual-trigger',
      status: 'success',
      inputJson: '[]',
      outputJson: '{}',
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    });
    storage.deleteWorkflow('wf_1');
    expect(storage.getWorkflow('wf_1')).toBeUndefined();
    expect(storage.getExecution(doomed.id)).toBeUndefined();
    expect(storage.listSteps(doomed.id)).toEqual([]);
    expect(storage.getExecution(kept.id)).toBeDefined();
  });

  it('deletes one execution and its steps', () => {
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
      inputJson: '[]',
      outputJson: '{}',
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    });
    storage.deleteExecution(created.id);
    expect(storage.getExecution(created.id)).toBeUndefined();
    expect(storage.listSteps(created.id)).toEqual([]);
  });

  it('marks stale running runs as interrupted', () => {
    const stale1 = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 1000,
    });
    const stale2 = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 2000,
    });
    const done = storage.createExecution({
      workflowId: 'wf_1',
      workflowName: 'Hello',
      trigger: 'manual',
      startedAt: 3000,
    });
    storage.updateExecution(done.id, { status: 'success', finishedAt: 3001 });
    expect(storage.markStaleRunningInterrupted()).toBe(2);
    for (const id of [stale1.id, stale2.id]) {
      const read = storage.getExecution(id);
      expect(read?.status).toBe('error');
      expect(read?.finishedAt).not.toBeNull();
      expect(read?.error).toContain('Interrupted');
    }
    expect(storage.getExecution(done.id)?.status).toBe('success');
    expect(storage.markStaleRunningInterrupted()).toBe(0);
  });

  it('prunes runs past the newest N per workflow', () => {
    const runs = [];
    for (let i = 1; i <= 5; i++) {
      runs.push(
        storage.createExecution({
          workflowId: 'wf_1',
          workflowName: 'Hello',
          trigger: 'manual',
          startedAt: i * 1000,
        }),
      );
    }
    const other = storage.createExecution({
      workflowId: 'wf_2',
      workflowName: 'Other',
      trigger: 'manual',
      startedAt: 1000,
    });
    storage.addStep({
      executionId: runs[0].id,
      nodeId: 'n1',
      nodeName: 'Start',
      nodeType: 'manual-trigger',
      status: 'success',
      inputJson: '[]',
      outputJson: '{}',
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    });
    expect(storage.pruneExecutions(2)).toBe(3);
    expect(storage.listExecutions('wf_1').map((e) => e.id)).toEqual([
      runs[4].id,
      runs[3].id,
    ]);
    expect(storage.listSteps(runs[0].id)).toEqual([]);
    expect(storage.getExecution(other.id)).toBeDefined();
  });

  it('lists executions with an offset', () => {
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      ids.push(
        storage.createExecution({
          workflowId: 'wf_1',
          workflowName: 'Hello',
          trigger: 'manual',
          startedAt: i * 1000,
        }).id,
      );
    }
    expect(storage.listExecutions(undefined, 2, 1).map((e) => e.id)).toEqual([
      ids[1],
      ids[0],
    ]);
    expect(storage.listExecutions('wf_1', 50, 99)).toEqual([]);
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
