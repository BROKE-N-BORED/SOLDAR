import { describe, expect, it } from 'vitest';
import {
  assertHasTrigger,
  reachableFromTriggers,
  topologicalSort,
  validateWorkflow,
  WorkflowValidationError,
} from './graph.js';
import type { NodeDefinition, Workflow } from './types.js';

function node(id: string, name = id, type = 'set'): Workflow['nodes'][number] {
  return { id, type, name, position: [0, 0], parameters: {} };
}

function workflow(
  nodes: Workflow['nodes'],
  connections: Workflow['connections'],
): Workflow {
  return { id: 'wf', name: 'Test', active: true, nodes, connections };
}

describe('validateWorkflow', () => {
  it('accepts a valid workflow', () => {
    expect(() =>
      validateWorkflow(
        workflow([node('a', 'A'), node('b', 'B')], [{ from: 'a', to: 'b' }]),
      ),
    ).not.toThrow();
  });

  it('rejects a workflow with no nodes', () => {
    expect(() => validateWorkflow(workflow([], []))).toThrow(WorkflowValidationError);
    expect(() => validateWorkflow(workflow([], []))).toThrow('no nodes');
  });

  it('rejects duplicate node ids', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'A'), node('a', 'B')], [])),
    ).toThrow('share the id "a"');
  });

  it('rejects duplicate node names', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'Same'), node('b', 'Same')], [])),
    ).toThrow('share the name "Same"');
  });

  it('rejects a connection to a node that does not exist', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'A')], [{ from: 'a', to: 'ghost' }])),
    ).toThrow('no node with id "ghost"');
  });

  it('rejects a connection from a node that does not exist', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'A')], [{ from: 'ghost', to: 'a' }])),
    ).toThrow('no node with id "ghost"');
  });

  it('rejects a node connected to itself', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'A')], [{ from: 'a', to: 'a' }])),
    ).toThrow('connects to itself');
  });

  it('rejects a cycle and names the loop', () => {
    expect(() =>
      validateWorkflow(
        workflow(
          [node('a', 'A'), node('b', 'B'), node('c', 'C')],
          [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', to: 'b' },
          ],
        ),
      ),
    ).toThrow('Cycle detected: b -> c -> b');
  });

  it('rejects a workflow with no id or no name', () => {
    const noId = workflow([node('a', 'A')], []);
    (noId as { id: string }).id = '';
    expect(() => validateWorkflow(noId)).toThrow('needs an id');
    const noName = workflow([node('a', 'A')], []);
    (noName as { name: string }).name = '';
    expect(() => validateWorkflow(noName)).toThrow('needs a name');
  });

  it('rejects a node with a broken position, but allows a missing one', () => {
    const bad = node('a', 'A');
    (bad as unknown as { position: unknown }).position = [100, 'x'];
    expect(() => validateWorkflow(workflow([bad], []))).toThrow('broken position');
    const missing = node('a', 'A');
    delete (missing as unknown as { position?: unknown }).position;
    expect(() => validateWorkflow(workflow([missing], []))).not.toThrow();
  });

  it('rejects duplicate connections', () => {
    expect(() =>
      validateWorkflow(
        workflow([node('a', 'A'), node('b', 'B')], [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' },
        ]),
      ),
    ).toThrow('Two identical wires');
  });

  it('rejects a chain deeper than the cycle-check limit', () => {
    const nodes = Array.from({ length: 1002 }, (_, i) => node(`n${i}`, `N${i}`));
    const connections = nodes
      .slice(0, -1)
      .map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
    expect(() => validateWorkflow(workflow(nodes, connections))).toThrow(
      'deeper than 1000',
    );
  });
});

describe('validateWorkflow with definitions', () => {
  const defs: NodeDefinition[] = [
    {
      type: 'set',
      displayName: 'Set',
      description: '',
      inputs: 1,
      outputs: ['main'],
      parameters: [],
      execute: async () => ({}),
    },
    {
      type: 'if',
      displayName: 'IF',
      description: '',
      inputs: 1,
      outputs: ['true', 'false'],
      parameters: [],
      execute: async () => ({}),
    },
  ];

  it('rejects an unknown node type', () => {
    expect(() =>
      validateWorkflow(workflow([node('a', 'A', 'nope')], []), defs),
    ).toThrow('unknown node type "nope"');
  });

  it('rejects a wire using an output the source node does not declare', () => {
    expect(() =>
      validateWorkflow(
        workflow([node('a', 'A', 'if'), node('b', 'B', 'set')], [
          { from: 'a', to: 'b', output: 'main' },
        ]),
        defs,
      ),
    ).toThrow('only has "true", "false"');
  });

  it('accepts wires using declared branch outputs', () => {
    expect(() =>
      validateWorkflow(
        workflow(
          [node('a', 'A', 'if'), node('b', 'B', 'set'), node('c', 'C', 'set')],
          [
            { from: 'a', to: 'b', output: 'true' },
            { from: 'a', to: 'c', output: 'false' },
          ],
        ),
        defs,
      ),
    ).not.toThrow();
  });
});

describe('topologicalSort', () => {
  it('orders a chain in run order', () => {
    const sorted = topologicalSort(
      workflow(
        [node('a', 'A'), node('b', 'B'), node('c', 'C')],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      ),
    );
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders a diamond so the join runs last', () => {
    const sorted = topologicalSort(
      workflow(
        [node('a', 'A'), node('b', 'B'), node('c', 'C'), node('d', 'D')],
        [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'd' },
          { from: 'c', to: 'd' },
        ],
      ),
    );
    const ids = sorted.map((n) => n.id);
    expect(ids[0]).toBe('a');
    expect(ids[3]).toBe('d');
    expect(new Set(ids.slice(1, 3))).toEqual(new Set(['b', 'c']));
  });

  it('keeps independent nodes in workflow order', () => {
    const sorted = topologicalSort(
      workflow([node('a', 'A'), node('b', 'B'), node('c', 'C')], []),
    );
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('throws on a cycle', () => {
    expect(() =>
      topologicalSort(
        workflow([node('a', 'A'), node('b', 'B')], [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ]),
      ),
    ).toThrow('Cycle detected: a -> b -> a');
  });

  it('throws on a dangling connection', () => {
    expect(() =>
      topologicalSort(workflow([node('a', 'A')], [{ from: 'a', to: 'ghost' }])),
    ).toThrow('does not exist');
  });
});

const DEFS: NodeDefinition[] = [
  {
    type: 'trigger',
    displayName: 'Trigger',
    description: 'A trigger.',
    inputs: 0,
    outputs: ['main'],
    parameters: [],
    async execute(ctx) {
      return { main: ctx.input };
    },
  },
  {
    type: 'set',
    displayName: 'Set',
    description: 'A normal node.',
    inputs: 1,
    outputs: ['main'],
    parameters: [],
    async execute(ctx) {
      return { main: ctx.input };
    },
  },
];

describe('reachableFromTriggers', () => {
  it('reaches the trigger and everything wired downstream of it', () => {
    const reached = reachableFromTriggers(
      workflow(
        [node('a', 'A', 'trigger'), node('b', 'B'), node('c', 'C'), node('d', 'D')],
        [
          { from: 'a', to: 'b' },
          { from: 'c', to: 'd' },
        ],
      ),
      DEFS,
    );
    expect([...reached].sort()).toEqual(['a', 'b']);
  });

  it('reaches nothing when there is no trigger', () => {
    const reached = reachableFromTriggers(
      workflow([node('a', 'A'), node('b', 'B')], [{ from: 'a', to: 'b' }]),
      DEFS,
    );
    expect(reached.size).toBe(0);
  });
});

describe('assertHasTrigger', () => {
  it('accepts a workflow with a trigger node', () => {
    expect(() =>
      assertHasTrigger(workflow([node('a', 'A', 'trigger')], []), DEFS),
    ).not.toThrow();
  });

  it('refuses a workflow with no trigger node, in plain words', () => {
    expect(() => assertHasTrigger(workflow([node('a', 'A')], []), DEFS)).toThrow(
      'no trigger node',
    );
  });
});
