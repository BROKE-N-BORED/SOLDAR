import { describe, expect, it } from 'vitest';
import { topologicalSort, validateWorkflow, WorkflowValidationError } from './graph.js';
import type { Workflow } from './types.js';

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
