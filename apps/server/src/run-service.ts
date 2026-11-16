// Runs workflows in the background and broadcasts step-by-step progress to
// WebSocket subscribers. The runner persists every step to SQLite itself;
// this service only forwards the live events.

import {
  runWorkflow,
  type ExecutionRecord,
  type Item,
  type RunResult,
  type RunStepResult,
  type Storage,
  type Workflow,
} from '@soldar/engine';
import { allNodes } from '@soldar/nodes';

export interface StepEvent {
  type: 'step';
  executionId: string;
  step: RunStepResult;
}

export interface DoneEvent {
  type: 'done';
  executionId: string;
  execution: ExecutionRecord;
}

export type RunEvent = StepEvent | DoneEvent;

export class RunService {
  private listeners = new Map<string, Set<(event: RunEvent) => void>>();

  constructor(private storage: Storage) {}

  /** Subscribe to live events for one execution. Returns an unsubscribe. */
  subscribe(executionId: string, fn: (event: RunEvent) => void): () => void {
    let set = this.listeners.get(executionId);
    if (!set) {
      set = new Set();
      this.listeners.set(executionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(executionId);
    };
  }

  private emit(executionId: string, event: RunEvent): void {
    for (const fn of this.listeners.get(executionId) ?? []) {
      try {
        fn(event);
      } catch {
        // A broken listener must never break the run.
      }
    }
  }

  /**
   * Start a run in the background. Resolves with the execution id as soon
   * as the run has started (before the first node runs). The workflow must
   * already be validated — the caller checks that first.
   */
  start(workflow: Workflow, triggerData?: Item[]): Promise<string> {
    let executionId = '';
    return new Promise<string>((resolve, reject) => {
      runWorkflow(workflow, allNodes, {
        storage: this.storage,
        triggerData,
        onExecutionStart: (id) => {
          executionId = id;
          resolve(id);
        },
        onStep: (step) => {
          this.emit(executionId, { type: 'step', executionId, step });
        },
      })
        .then((result: RunResult) => {
          const execution = result.executionId
            ? this.storage.getExecution(result.executionId)
            : undefined;
          if (execution) {
            this.emit(execution.id, { type: 'done', executionId: execution.id, execution });
          }
        })
        .catch((err: unknown) => {
          // runWorkflow catches node errors itself, so reaching here means
          // something failed outside a node (e.g. storage died mid-run).
          // Record it if a run had started, then report the failure.
          if (executionId) {
            try {
              this.storage.updateExecution(executionId, {
                status: 'error',
                finishedAt: Date.now(),
                error: err instanceof Error ? err.message : String(err),
              });
              const execution = this.storage.getExecution(executionId);
              if (execution) {
                this.emit(executionId, { type: 'done', executionId, execution });
              }
            } catch {
              // Nothing more can be done.
            }
          }
          reject(err);
        });
    });
  }
}
