import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkflow } from './runner.js';
import { createStorage } from './storage.js';
import type { Item, NodeDefinition, Workflow } from './types.js';

const passThrough: NodeDefinition = {
  type: 'pass',
  displayName: 'Pass',
  description: 'Passes items through unchanged.',
  inputs: 1,
  outputs: ['main'],
  parameters: [],
  async execute(ctx) {
    return { main: ctx.input };
  },
};

const tagger: NodeDefinition = {
  type: 'tag',
  displayName: 'Tag',
  description: 'Adds a field from its params to each item.',
  inputs: 1,
  outputs: ['main'],
  parameters: [],
  async execute(ctx) {
    const field = String(ctx.params.field);
    return {
      main: ctx.input.map((item) => ({
        json: { ...item.json, [field]: ctx.params.value },
      })),
    };
  },
};

const failer: NodeDefinition = {
  type: 'fail',
  displayName: 'Fail',
  description: 'Always throws.',
  inputs: 1,
  outputs: ['main'],
  parameters: [],
  async execute() {
    throw new Error('kaboom');
  },
};

const brancher: NodeDefinition = {
  type: 'branch',
  displayName: 'Branch',
  description: 'Sends items to "yes" when params.go is true, else "no".',
  inputs: 1,
  outputs: ['yes', 'no'],
  parameters: [],
  async execute(ctx) {
    return ctx.params.go === true
      ? { yes: ctx.input, no: [] }
      : { yes: [], no: ctx.input };
  },
};

const trigger: NodeDefinition = {
  type: 'trigger',
  displayName: 'Trigger',
  description: 'A trigger.',
  inputs: 0,
  outputs: ['main'],
  parameters: [],
  async execute(ctx) {
    return { main: ctx.input };
  },
};

const ALL = [passThrough, tagger, failer, brancher, trigger];

function node(
  id: string,
  type: string,
  name: string,
  parameters: Record<string, unknown> = {},
): Workflow['nodes'][number] {
  return { id, type, name, position: [0, 0], parameters };
}

function wf(nodes: Workflow['nodes'], connections: Workflow['connections']): Workflow {
  return { id: 'wf_1', name: 'Test workflow', active: true, nodes, connections };
}

describe('runWorkflow', () => {
  it('runs a chain in order and passes items along', async () => {
    const result = await runWorkflow(
      wf(
        [node('t', 'trigger', 'Start'), node('a', 'tag', 'Tag it', { field: 'x', value: 1 }), node('b', 'pass', 'Pass')],
        [
          { from: 't', to: 'a' },
          { from: 'a', to: 'b' },
        ],
      ),
      ALL,
      { triggerData: [{ json: { seed: true } }] },
    );
    expect(result.status).toBe('success');
    expect(result.steps.map((s) => s.nodeName)).toEqual(['Start', 'Tag it', 'Pass']);
    expect(result.steps[2].output.main).toEqual([{ json: { seed: true, x: 1 } }]);
  });

  it('evaluates expressions per item before the node runs', async () => {
    const result = await runWorkflow(
      wf(
        [node('t', 'trigger', 'Start'), node('a', 'tag', 'Tag it', { field: 'doubled', value: '{{ $json.n * 2 }}' })],
        [{ from: 't', to: 'a' }],
      ),
      ALL,
      { triggerData: [{ json: { n: 3 } }, { json: { n: 10 } }] },
    );
    expect(result.status).toBe('success');
    expect(result.steps[1].output.main).toEqual([
      { json: { n: 3, doubled: 6 } },
      { json: { n: 10, doubled: 20 } },
    ]);
  });

  it('routes branches and skips nodes on wires that carried nothing', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('b', 'branch', 'Pick', { go: false }),
          node('y', 'pass', 'Yes path'),
          node('n', 'pass', 'No path'),
        ],
        [
          { from: 't', to: 'b' },
          { from: 'b', to: 'y', output: 'yes' },
          { from: 'b', to: 'n', output: 'no' },
        ],
      ),
      ALL,
    );
    expect(result.status).toBe('success');
    const byName = new Map(result.steps.map((s) => [s.nodeName, s]));
    expect(byName.get('Yes path')?.status).toBe('skipped');
    expect(byName.get('No path')?.status).toBe('success');
  });

  it('stops the run on a node error and records it on that step', async () => {
    const result = await runWorkflow(
      wf(
        [node('t', 'trigger', 'Start'), node('f', 'fail', 'Boom'), node('b', 'pass', 'Never')],
        [
          { from: 't', to: 'f' },
          { from: 'f', to: 'b' },
        ],
      ),
      ALL,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('Node "Boom" failed: kaboom');
    expect(result.steps.map((s) => s.nodeName)).toEqual(['Start', 'Boom']);
    expect(result.steps[1].status).toBe('error');
    expect(result.steps[1].error).toBe('kaboom');
  });

  it('rejects an unknown node type before running anything', async () => {
    await expect(
      runWorkflow(wf([node('t', 'nope', 'Start')], []), ALL),
    ).rejects.toThrow('unknown node type "nope"');
  });

  it('rejects a cyclic workflow before running anything', async () => {
    await expect(
      runWorkflow(
        wf([node('a', 'pass', 'A'), node('b', 'pass', 'B')], [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ]),
        ALL,
      ),
    ).rejects.toThrow('Cycle detected');
  });

  it('calls onStep after each node', async () => {
    const seen: string[] = [];
    await runWorkflow(
      wf([node('t', 'trigger', 'Start'), node('b', 'pass', 'Pass')], [{ from: 't', to: 'b' }]),
      ALL,
      { onStep: (step) => seen.push(`${step.nodeName}:${step.status}`) },
    );
    expect(seen).toEqual(['Start:success', 'Pass:success']);
  });

  it('persists the execution and its steps in SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soldar-runner-test-'));
    const storage = createStorage(join(dir, 'run.db'));
    try {
      const result = await runWorkflow(
        wf(
          [node('t', 'trigger', 'Start'), node('a', 'tag', 'Tag it', { field: 'x', value: 1 })],
          [{ from: 't', to: 'a' }],
        ),
        ALL,
        { storage, triggerData: [{ json: {} }] },
      );
      expect(result.status).toBe('success');
      expect(result.executionId).toMatch(/^exec_/);

      const execution = storage.getExecution(result.executionId!);
      expect(execution?.status).toBe('success');
      expect(execution?.workflowName).toBe('Test workflow');
      expect(execution?.trigger).toBe('manual');
      expect(execution?.finishedAt).not.toBeNull();

      const steps = storage.listSteps(result.executionId!);
      expect(steps).toHaveLength(2);
      expect(steps.map((s) => s.nodeName)).toEqual(['Start', 'Tag it']);
      const tagStep = steps[1];
      expect(JSON.parse(tagStep.outputJson)).toEqual({ main: [{ json: { x: 1 } }] });
      expect(JSON.parse(tagStep.inputJson)).toEqual([{ json: {} }]);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a failed run with the error on the execution and step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soldar-runner-test-'));
    const storage = createStorage(join(dir, 'run.db'));
    try {
      const result = await runWorkflow(
        wf([node('t', 'trigger', 'Start'), node('f', 'fail', 'Boom')], [{ from: 't', to: 'f' }]),
        ALL,
        { storage },
      );
      expect(result.status).toBe('error');
      const execution = storage.getExecution(result.executionId!);
      expect(execution?.status).toBe('error');
      expect(execution?.error).toContain('Node "Boom" failed');
      const steps = storage.listSteps(result.executionId!);
      expect(steps).toHaveLength(2);
      expect(steps[1].status).toBe('error');
      expect(steps[1].error).toBe('kaboom');
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
