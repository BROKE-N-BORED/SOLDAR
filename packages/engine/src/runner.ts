// The runner: takes a workflow JSON + a trigger and produces an execution.
//
// 1. Validate the graph (no cycles, every connection points at a real node).
// 2. Sort nodes into run order.
// 3. Run each node with its inputs. Trigger nodes run first with the trigger
//    data. A node whose incoming wires carried no items is skipped.
// 4. Save each node's input/output to execution_steps as it goes, so a
//    failed run still shows how far it got.
// 5. On a node error: stop the run, record the error on that step.

import { evaluateParameters, type ExpressionScope } from './expressions.js';
import { topologicalSort, validateWorkflow, WorkflowValidationError } from './graph.js';
import type { Storage } from './storage.js';
import type {
  Item,
  NodeContext,
  NodeDefinition,
  NodeOutput,
  Workflow,
  WorkflowNode,
} from './types.js';

export type StepStatus = 'success' | 'error' | 'skipped';

export interface RunStepResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: StepStatus;
  input: Item[];
  output: NodeOutput;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface RunResult {
  executionId: string | null;
  workflowId: string;
  workflowName: string;
  status: 'success' | 'error';
  steps: RunStepResult[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
}

export interface RunOptions {
  /** Items handed to trigger nodes. Default: one empty item. */
  triggerData?: Item[];
  /** Where executions are stored. If omitted, the run is not persisted. */
  storage?: Storage;
  /** Called after each node finishes (or fails, or is skipped). */
  onStep?: (step: RunStepResult) => void;
  log?: (msg: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyOutput(definition: NodeDefinition): NodeOutput {
  const out: NodeOutput = {};
  for (const name of definition.outputs) out[name] = [];
  return out;
}

export async function runWorkflow(
  workflow: Workflow,
  definitions: NodeDefinition[],
  options: RunOptions = {},
): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const startedAt = Date.now();

  // Validation happens before anything is recorded: an invalid workflow
  // never starts an execution.
  validateWorkflow(workflow);
  const registry = new Map(definitions.map((d) => [d.type, d]));
  for (const node of workflow.nodes) {
    if (!registry.has(node.type)) {
      throw new WorkflowValidationError(
        `Node "${node.name}" uses unknown node type "${node.type}".`,
      );
    }
  }
  const order = topologicalSort(workflow);

  const incoming = new Map<string, { from: string; output: string }[]>();
  for (const node of workflow.nodes) incoming.set(node.id, []);
  for (const conn of workflow.connections) {
    incoming.get(conn.to)!.push({ from: conn.from, output: conn.output ?? 'main' });
  }

  const storage = options.storage;
  const execution = storage?.createExecution({
    workflowId: workflow.id,
    workflowName: workflow.name,
    trigger: 'manual',
    startedAt,
  });
  const executionId = execution?.id ?? null;

  const steps: RunStepResult[] = [];
  // Node outputs by node id, for wiring; and by node name, for $node["Name"].
  const outputsById = new Map<string, NodeOutput>();
  const outputsByName = new Map<string, Item[]>();

  const recordStep = (step: RunStepResult) => {
    steps.push(step);
    storage?.addStep({
      executionId: executionId!,
      nodeId: step.nodeId,
      nodeName: step.nodeName,
      nodeType: step.nodeType,
      status: step.status,
      inputJson: JSON.stringify(step.input),
      outputJson: JSON.stringify(step.output),
      error: step.error ?? null,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    });
    options.onStep?.(step);
  };

  const finish = (status: 'success' | 'error', error?: string): RunResult => {
    const finishedAt = Date.now();
    if (storage && executionId) {
      storage.updateExecution(executionId, {
        status,
        finishedAt,
        error: error ?? null,
      });
    }
    return {
      executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status,
      steps,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ...(error ? { error } : {}),
    };
  };

  try {
    for (const node of order) {
      const definition = registry.get(node.type)!;
      const nodeStarted = Date.now();
      const wires = incoming.get(node.id) ?? [];

      // Gather this node's input from its incoming wires.
      let input: Item[];
      if (wires.length === 0) {
        // A trigger node: no wires in, runs first with the trigger data.
        input = options.triggerData ?? [{ json: {} }];
      } else {
        input = [];
        for (const wire of wires) {
          const source = outputsById.get(wire.from);
          const items = source?.[wire.output] ?? [];
          input.push(...items);
        }
      }

      if (wires.length > 0 && input.length === 0) {
        // Nothing arrived on the wires (e.g. an IF branch that didn't fire).
        // The node is skipped, and so is everything downstream of it.
        const step: RunStepResult = {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'skipped',
          input: [],
          output: emptyOutput(definition),
          startedAt: nodeStarted,
          finishedAt: Date.now(),
        };
        outputsById.set(node.id, step.output);
        outputsByName.set(node.name, []);
        log(`Skipped ${node.name}: no items arrived.`);
        recordStep(step);
        continue;
      }

      const scopeFor = (item: Item): ExpressionScope => ({
        item,
        nodeOutputs: outputsByName,
      });

      const baseContext: Omit<NodeContext, 'input' | 'params'> = {
        credentials: async () => {
          throw new Error(
            'Credentials are not available in Phase 1 — the credentials store arrives in Phase 4.',
          );
        },
        log: (msg: string) => log(`[${node.name}] ${msg}`),
        workflow: {
          id: workflow.id,
          name: workflow.name,
          settings: workflow.settings,
        },
      };

      try {
        let output: NodeOutput;
        if (definition.executeMode === 'allItems') {
          // One call with every item; params evaluated against the first.
          const params = evaluateParameters(
            node.parameters,
            scopeFor(input[0] ?? { json: {} }),
          );
          output = await definition.execute({
            ...baseContext,
            input,
            params,
          });
        } else {
          // One call per item, params evaluated against that item.
          output = emptyOutput(definition);
          for (const item of input) {
            const params = evaluateParameters(node.parameters, scopeFor(item));
            const result = await definition.execute({
              ...baseContext,
              input: [item],
              params,
            });
            for (const [name, items] of Object.entries(result)) {
              (output[name] ??= []).push(...items);
            }
          }
        }

        const step: RunStepResult = {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'success',
          input,
          output,
          startedAt: nodeStarted,
          finishedAt: Date.now(),
        };
        outputsById.set(node.id, output);
        outputsByName.set(node.name, output.main ?? []);
        recordStep(step);
      } catch (err) {
        const message = errorMessage(err);
        const step: RunStepResult = {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'error',
          input,
          output: {},
          error: message,
          startedAt: nodeStarted,
          finishedAt: Date.now(),
        };
        recordStep(step);
        return finish('error', `Node "${node.name}" failed: ${message}`);
      }
    }

    return finish('success');
  } catch (err) {
    // Something failed outside a node (e.g. storage). Record it if we can.
    const message = errorMessage(err);
    return finish('error', message);
  }
}
