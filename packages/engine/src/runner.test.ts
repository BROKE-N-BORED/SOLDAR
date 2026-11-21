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

const coder: NodeDefinition = {
  type: 'coder',
  displayName: 'Coder',
  description: 'Returns its code param untouched.',
  inputs: 1,
  outputs: ['main'],
  parameters: [{ name: 'code', displayName: 'Code', type: 'code' }],
  async execute(ctx) {
    return { main: [{ json: { code: ctx.params.code } }] };
  },
};

const ALL = [passThrough, tagger, failer, brancher, trigger, coder];

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

  it('leaves code-type parameters untouched by expression evaluation', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('c', 'coder', 'Coder', { code: 'return {{ x }};' }),
        ],
        [{ from: 't', to: 'c' }],
      ),
      ALL,
    );
    expect(result.status).toBe('success');
    expect(result.steps[1].output.main).toEqual([{ json: { code: 'return {{ x }};' } }]);
  });

  it('lets $node["Name"] see branch outputs, not just main', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('b', 'branch', 'Pick', { go: true }),
          node(
            'y',
            'tag',
            'Yes path',
            { field: 'fromBranch', value: '{{ $node["Pick"].json.seed }}' },
          ),
        ],
        [
          { from: 't', to: 'b' },
          { from: 'b', to: 'y', output: 'yes' },
        ],
      ),
      ALL,
      { triggerData: [{ json: { seed: true } }] },
    );
    expect(result.status).toBe('success');
    expect(result.steps[2].output.main).toEqual([{ json: { seed: true, fromBranch: true } }]);
  });

  it('calls onExecutionStart with the execution id before any step runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soldar-runner-test-'));
    const storage = createStorage(join(dir, 'run.db'));
    try {
      const order: string[] = [];
      const result = await runWorkflow(
        wf([node('t', 'trigger', 'Start'), node('b', 'pass', 'Pass')], [{ from: 't', to: 'b' }]),
        ALL,
        {
          storage,
          onExecutionStart: (id) => order.push(`start:${id}`),
          onStep: (step) => order.push(`step:${step.nodeName}`),
        },
      );
      expect(result.executionId).toMatch(/^exec_/);
      expect(order).toEqual([`start:${result.executionId}`, 'step:Start', 'step:Pass']);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the run when the abort signal fires between nodes', async () => {
    const controller = new AbortController();
    const result = await runWorkflow(
      wf(
        [node('t', 'trigger', 'Start'), node('p', 'pass', 'Pass'), node('q', 'pass', 'Never')],
        [
          { from: 't', to: 'p' },
          { from: 'p', to: 'q' },
        ],
      ),
      ALL,
      {
        signal: controller.signal,
        onStep: (step) => {
          if (step.nodeName === 'Start') controller.abort();
        },
      },
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('Run stopped.');
    expect(result.steps.map((s) => s.nodeName)).toEqual(['Start']);
  });

  it('stops a run aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkflow(
      wf([node('t', 'trigger', 'Start')], []),
      ALL,
      { signal: controller.signal },
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('Run stopped.');
    expect(result.steps).toEqual([]);
  });

  it('warns when wiring contradicts a node inputs declaration', async () => {
    const warnings: string[] = [];
    // A trigger with a wire feeding it still warns. A normal node with
    // no wires no longer warns: it is loose now, so it is skipped with
    // a note on its step instead of running as a trigger.
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('t2', 'trigger', 'Second trigger'),
          node('p', 'pass', 'Lonely'),
        ],
        [{ from: 't', to: 't2' }],
      ),
      ALL,
      { warn: (msg) => warnings.push(msg) },
    );
    expect(warnings).toHaveLength(1);
    const joined = warnings.join('\n');
    expect(joined).toContain('"Second trigger"');
    expect(joined).toContain('is a trigger');
    const lonely = result.steps.find((s) => s.nodeName === 'Lonely')!;
    expect(lonely.status).toBe('skipped');
    expect(lonely.note).toContain('Not wired to the trigger');
  });

  it('does not warn when the wiring matches the declarations', async () => {
    const warnings: string[] = [];
    await runWorkflow(
      wf([node('t', 'trigger', 'Start'), node('p', 'pass', 'Pass')], [{ from: 't', to: 'p' }]),
      ALL,
      { warn: (msg) => warnings.push(msg) },
    );
    expect(warnings).toEqual([]);
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

  it('skips loose nodes instead of running them', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('a', 'tag', 'Tag it', { field: 'x', value: 1 }),
          node('l', 'pass', 'Loose'),
        ],
        [{ from: 't', to: 'a' }],
      ),
      ALL,
      { triggerData: [{ json: { seed: true } }] },
    );
    expect(result.status).toBe('success');
    const loose = result.steps.find((s) => s.nodeName === 'Loose')!;
    expect(loose.status).toBe('skipped');
    expect(loose.note).toContain('Not wired to the trigger');
    expect(result.steps.find((s) => s.nodeName === 'Tag it')!.status).toBe('success');
  });

  it('a loose failing node cannot break the run', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('a', 'pass', 'Pass'),
          node('f', 'fail', 'Loose boom'),
        ],
        [{ from: 't', to: 'a' }],
      ),
      ALL,
    );
    expect(result.status).toBe('success');
    expect(result.steps.find((s) => s.nodeName === 'Loose boom')!.status).toBe('skipped');
  });

  it('skips a node wired only from a loose node', async () => {
    const result = await runWorkflow(
      wf(
        [
          node('t', 'trigger', 'Start'),
          node('l', 'pass', 'Loose'),
          node('d', 'pass', 'Downstream of loose'),
        ],
        [{ from: 'l', to: 'd' }],
      ),
      ALL,
    );
    expect(result.status).toBe('success');
    const downstream = result.steps.find((s) => s.nodeName === 'Downstream of loose')!;
    expect(downstream.status).toBe('skipped');
    expect(downstream.note).toContain('Not wired to the trigger');
  });

  it('refuses a workflow with no trigger node', async () => {
    await expect(
      runWorkflow(wf([node('a', 'pass', 'Pass')], []), ALL),
    ).rejects.toThrow('no trigger node');
  });

  it('singleNode runs a lone node with no trigger anywhere', async () => {
    const result = await runWorkflow(
      wf([node('a', 'tag', 'Tag it', { field: 'x', value: 7 })], []),
      ALL,
      { singleNode: true, triggerData: [{ json: {} }] },
    );
    expect(result.status).toBe('success');
    expect(result.steps[0].output.main).toEqual([{ json: { x: 7 } }]);
  });

  it('notes why a node on an untaken branch was skipped', async () => {
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
    const yes = result.steps.find((s) => s.nodeName === 'Yes path')!;
    expect(yes.status).toBe('skipped');
    expect(yes.note).toContain('Nothing arrived on its wires');
  });

  it('persists the skip note on the stored step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soldar-runner-test-'));
    const storage = createStorage(join(dir, 'run.db'));
    try {
      const result = await runWorkflow(
        wf(
          [node('t', 'trigger', 'Start'), node('l', 'pass', 'Loose')],
          [],
        ),
        ALL,
        { storage },
      );
      expect(result.status).toBe('success');
      const steps = storage.listSteps(result.executionId!);
      const loose = steps.find((s) => s.nodeName === 'Loose')!;
      expect(loose.status).toBe('skipped');
      expect(loose.note).toContain('Not wired to the trigger');
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
