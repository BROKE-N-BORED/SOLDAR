// Graph validation and run order (topological sort).

import type { NodeDefinition, Workflow, WorkflowNode } from './types.js';

/** Deepest chain the cycle check follows before refusing. A workflow with
 *  a longer chain than this is almost certainly a mistake, and the
 *  recursive check would overflow the stack first. */
const MAX_CYCLE_DEPTH = 1000;

/** A problem with the workflow graph, phrased for a person, not a log. */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Validate a workflow graph: nodes are well-formed, names and ids are
 * unique, every connection points at a real node, and there are no cycles.
 * When node definitions are passed, node types and connection outputs are
 * checked against them too. Throws WorkflowValidationError on the first
 * problem found.
 */
export function validateWorkflow(workflow: Workflow, definitions?: NodeDefinition[]): void {
  if (!workflow || typeof workflow !== 'object') {
    throw new WorkflowValidationError('Workflow is not an object.');
  }
  if (typeof workflow.id !== 'string' || workflow.id === '') {
    throw new WorkflowValidationError('Every workflow needs an id.');
  }
  if (typeof workflow.name !== 'string' || workflow.name === '') {
    throw new WorkflowValidationError('Every workflow needs a name.');
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    throw new WorkflowValidationError('Workflow has no nodes.');
  }
  if (!Array.isArray(workflow.connections)) {
    throw new WorkflowValidationError('Workflow connections must be a list.');
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || node.id === '') {
      throw new WorkflowValidationError('Every node needs an id.');
    }
    if (ids.has(node.id)) {
      throw new WorkflowValidationError(
        `Two nodes share the id "${node.id}". Node ids must be unique.`,
      );
    }
    ids.add(node.id);
    if (typeof node.name !== 'string' || node.name === '') {
      throw new WorkflowValidationError(
        `Node "${node.id}" has no name. Every node needs a name.`,
      );
    }
    if (names.has(node.name)) {
      throw new WorkflowValidationError(
        `Two nodes share the name "${node.name}". Node names must be unique ` +
          `so expressions like {{ $node["${node.name}"].json }} know which node you mean.`,
      );
    }
    names.add(node.name);
    if (typeof node.type !== 'string' || node.type === '') {
      throw new WorkflowValidationError(
        `Node "${node.name}" has no type.`,
      );
    }
    if (node.parameters === undefined || node.parameters === null) {
      throw new WorkflowValidationError(
        `Node "${node.name}" has no parameters object. Use {} for no settings.`,
      );
    }
    // A missing position is fine — the editor gives it a default. A broken
    // one (not two numbers) would throw the whole editor page.
    if (node.position !== undefined && node.position !== null) {
      const pos: unknown = node.position;
      if (
        !Array.isArray(pos) ||
        pos.length !== 2 ||
        !pos.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new WorkflowValidationError(
          `Node "${node.name}" has a broken position. Positions are two numbers, like [100, 200].`,
        );
      }
    }
  }

  // When the node definitions are known, every node type must exist.
  let byType: Map<string, NodeDefinition> | null = null;
  if (definitions) {
    byType = new Map(definitions.map((d) => [d.type, d]));
    for (const node of workflow.nodes) {
      if (!byType.has(node.type)) {
        throw new WorkflowValidationError(
          `Node "${node.name}" uses unknown node type "${node.type}".`,
        );
      }
    }
  }

  const seenConnections = new Set<string>();
  for (const conn of workflow.connections) {
    if (!conn || typeof conn.from !== 'string' || typeof conn.to !== 'string') {
      throw new WorkflowValidationError(
        'Every connection needs a "from" node id and a "to" node id.',
      );
    }
    if (!ids.has(conn.from)) {
      throw new WorkflowValidationError(
        `Connection from "${conn.from}" to "${conn.to}": there is no node with id "${conn.from}".`,
      );
    }
    if (!ids.has(conn.to)) {
      throw new WorkflowValidationError(
        `Connection from "${conn.from}" to "${conn.to}": there is no node with id "${conn.to}".`,
      );
    }
    if (conn.from === conn.to) {
      throw new WorkflowValidationError(
        `Node "${conn.from}" connects to itself.`,
      );
    }
    const output = conn.output ?? 'main';
    const key = `${conn.from}|${output}|${conn.to}`;
    if (seenConnections.has(key)) {
      throw new WorkflowValidationError(
        `Two identical wires run from "${conn.from}" to "${conn.to}". One is ` +
          `enough — duplicates make the next node process everything twice.`,
      );
    }
    seenConnections.add(key);
    // When the node definitions are known, the wire must leave through an
    // output the source node actually declares — otherwise the whole
    // downstream branch is silently skipped.
    if (byType) {
      const source = workflow.nodes.find((n) => n.id === conn.from)!;
      const def = byType.get(source.type)!;
      if (!def.outputs.includes(output)) {
        throw new WorkflowValidationError(
          `The wire from "${source.name}" uses output "${output}", but that ` +
            `node only has ${def.outputs.map((o) => `"${o}"`).join(', ')}.`,
        );
      }
    }
  }

  // Cycles, with the actual loop named in the error.
  const cycle = findCycle(workflow);
  if (cycle) {
    throw new WorkflowValidationError(
      `Cycle detected: ${cycle.join(' -> ')}. A workflow cannot loop back on itself.`,
    );
  }
}

/** Depth-first search for a cycle. Returns the loop as node ids, or null. */
function findCycle(workflow: Workflow): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) outgoing.set(node.id, []);
  for (const conn of workflow.connections) {
    outgoing.get(conn.from)!.push(conn.to);
  }

  // 0 = unvisited, 1 = on the current path, 2 = done
  const state = new Map<string, number>();
  const path: string[] = [];

  const visit = (id: string, depth: number): string[] | null => {
    if (depth > MAX_CYCLE_DEPTH) {
      throw new WorkflowValidationError(
        `The workflow chain runs deeper than ${MAX_CYCLE_DEPTH} nodes. ` +
          `That is almost certainly a mistake — split the workflow into smaller pieces.`,
      );
    }
    state.set(id, 1);
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        // Found the loop: from its first occurrence on the path, back to itself.
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (s === 0) {
        const found = visit(next, depth + 1);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const node of workflow.nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      const found = visit(node.id, 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Nodes in run order: a node appears only after everything feeding into it.
 * Throws WorkflowValidationError if the graph has a cycle.
 */
export function topologicalSort(workflow: Workflow): WorkflowNode[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const conn of workflow.connections) {
    if (!byId.has(conn.from) || !byId.has(conn.to)) {
      throw new WorkflowValidationError(
        `Connection from "${conn.from}" to "${conn.to}" points at a node that does not exist.`,
      );
    }
    inDegree.set(conn.to, (inDegree.get(conn.to) ?? 0) + 1);
    outgoing.get(conn.from)!.push(conn.to);
  }

  // Start with nodes that have nothing feeding into them, in workflow order.
  // The queue is read by index, not shift(): shift() is O(n) per node and
  // makes the whole sort O(n^2) on very large workflows.
  const queue: string[] = workflow.nodes
    .filter((n) => inDegree.get(n.id) === 0)
    .map((n) => n.id);
  const sorted: WorkflowNode[] = [];
  let head = 0;

  while (head < queue.length) {
    const id = queue[head++]!;
    sorted.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (sorted.length !== workflow.nodes.length) {
    const cycle = findCycle(workflow);
    throw new WorkflowValidationError(
      cycle
        ? `Cycle detected: ${cycle.join(' -> ')}. A workflow cannot loop back on itself.`
        : 'Cycle detected: the workflow graph has a loop.',
    );
  }
  return sorted;
}
