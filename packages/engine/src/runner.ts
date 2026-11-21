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
import {
  assertHasTrigger,
  reachableFromTriggers,
  topologicalSort,
  validateWorkflow,
} from './graph.js';
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
  /** Plain-words reason a step did not run (a skipped step). */
  note?: string;
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
  /** Called right after the execution record is created (before any node
   *  runs), with the execution id. The server uses it to hand the id to
   *  the UI so it can subscribe to live progress. */
  onExecutionStart?: (executionId: string) => void;
  /** Called after each node finishes (or fails, or is skipped). */
  onStep?: (step: RunStepResult) => void;
  log?: (msg: string) => void;
  /**
   * Abort signal for cancelling the run (the Stop button). Checked between
   * nodes and between items; a node already running finishes its current
   * call first, then the run stops.
   */
  signal?: AbortSignal;
  /**
   * Warnings about the workflow itself — wiring that contradicts a node's
   * declared inputs. Separate from log so the server can file them as
   * warnings.
   */
  warn?: (msg: string) => void;
  /**
   * True when the caller is running one node on its own ("Run just this
   * node"): the reachability rule is skipped and the node runs with the
   * trigger data, exactly as a trigger would.
   */
  singleNode?: boolean;
  /** How this run was started: 'manual' (default), 'schedule', or 'webhook'.
   *  Recorded on the execution so the history can say what started it. */
  triggerName?: string;
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
  // never starts an execution. Definitions are passed so node types and
  // connection outputs are checked against the registry too.
  const registry = new Map(definitions.map((d) => [d.type, d]));
  validateWorkflow(workflow, definitions);
  const order = topologicalSort(workflow);

  // Only nodes a trigger can reach take part in a run. A loose node (on
  // the canvas but wired to nothing a trigger reaches) is recorded as
  // skipped instead of running — before this, a half-built loose node
  // could fail or pollute every run. A workflow with no trigger node at
  // all cannot start, and says so plainly. Single-node runs are exempt:
  // the one node is the whole point of the run.
  let reachable: Set<string> | null = null;
  if (!options.singleNode) {
    assertHasTrigger(workflow, definitions);
    reachable = reachableFromTriggers(workflow, definitions);
  }

  const incoming = new Map<string, { from: string; output: string }[]>();
  for (const node of workflow.nodes) incoming.set(node.id, []);
  for (const conn of workflow.connections) {
    incoming.get(conn.to)!.push({ from: conn.from, output: conn.output ?? 'main' });
  }

  const storage = options.storage;
  const execution = storage?.createExecution({
    workflowId: workflow.id,
    workflowName: workflow.name,
    trigger: options.triggerName ?? 'manual',
    startedAt,
  });
  const executionId = execution?.id ?? null;
  if (executionId) options.onExecutionStart?.(executionId);

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
      note: step.note ?? null,
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
      if (options.signal?.aborted) {
        return finish('error', 'Run stopped.');
      }
      const definition = registry.get(node.type)!;
      const nodeStarted = Date.now();
      const wires = incoming.get(node.id) ?? [];

      if (reachable !== null && !reachable.has(node.id)) {
        // Loose node: no path from a trigger reaches it, so it does not
        // run. Recorded as skipped, with the reason on the step, and
        // everything downstream of it sees empty output (it is loose
        // too, or fed only by loose nodes, so it lands here as well).
        const step: RunStepResult = {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'skipped',
          input: [],
          output: emptyOutput(definition),
          note: 'Not wired to the trigger, so this node did not run.',
          startedAt: nodeStarted,
          finishedAt: Date.now(),
        };
        outputsById.set(node.id, step.output);
        outputsByName.set(node.name, []);
        log(`Skipped ${node.name}: not wired to the trigger.`);
        recordStep(step);
        continue;
      }

      // The inputs declaration is a promise about wiring: a trigger with
      // wires, or a normal node with none, runs anyway but says so.
      const warn = options.warn ?? (() => {});
      if (definition.inputs === 0 && wires.length > 0) {
        warn(
          `Node "${node.name}" is a trigger (it takes no inputs) but has ` +
            `wires feeding into it. The wires win and it runs as a normal node.`,
        );
      } else if (definition.inputs > 0 && wires.length === 0) {
        warn(
          `Node "${node.name}" takes an input but nothing feeds into it, ` +
            `so it runs as a trigger with the trigger data.`,
        );
      }

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
          note: 'Nothing arrived on its wires, so this node did not run.',
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
        rawParams: node.parameters,
        credentials: async () => {
          throw new Error(
            'Credentials are not available in Phase 1. The credentials store arrives in Phase 4.',
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
        // Code-type settings hold literal code — a {{ in a script is not
        // a template and must reach the node untouched.
        const codeParams = new Set(
          definition.parameters
            .filter((p) => p.type === 'code')
            .map((p) => p.name),
        );
        let output: NodeOutput;
        if (definition.executeMode === 'allItems') {
          // One call with every item; params evaluated against the first.
          const params = evaluateParameters(
            node.parameters,
            scopeFor(input[0] ?? { json: {} }),
            codeParams,
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
            if (options.signal?.aborted) {
              return finish('error', 'Run stopped.');
            }
            const params = evaluateParameters(node.parameters, scopeFor(item), codeParams);
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
        // $node["Name"] sees every output, not just "main": an IF node's
        // true/false branches are both branch data, and expressions
        // against them used to come back empty.
        outputsByName.set(node.name, Object.values(output).flat());
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

    // Aborted during the last node: the run still stops, even though every
    // node finished — the user asked for it to stop, so the result is
    // discarded.
    if (options.signal?.aborted) {
      return finish('error', 'Run stopped.');
    }
    return finish('success');
  } catch (err) {
    // Something failed outside a node (e.g. storage). Record it if we can.
    const message = errorMessage(err);
    return finish('error', message);
  }
}
