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
import type { Logger } from './logger.js';

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

/** Thrown by start() when the concurrent-run cap is already reached. */
export class RunServiceBusyError extends Error {
  constructor() {
    super(
      'Two runs are already going. Wait for one to finish, or stop it, then try again.',
    );
    this.name = 'RunServiceBusyError';
  }
}

/**
 * At most two runs at once: every run is accepted today, and each Code
 * node can take 128 MB, so heavy runs can freeze the desktop.
 */
const MAX_CONCURRENT_RUNS = 2;

export class RunService {
  private listeners = new Map<string, Set<(event: RunEvent) => void>>();
  /** Abort controllers for runs in flight, by execution id. */
  private running = new Map<string, AbortController>();
  /** Every run promise, for waiting out a shutdown. */
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    private storage: Storage,
    private logger?: Logger,
  ) {}

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
   * already be validated — the caller checks that first. Rejects with
   * RunServiceBusyError when two runs are already going.
   */
  start(
    workflow: Workflow,
    triggerData?: Item[],
    options?: { singleNode?: boolean; trigger?: string },
  ): Promise<string> {
    if (this.running.size >= MAX_CONCURRENT_RUNS) {
      return Promise.reject(new RunServiceBusyError());
    }
    const controller = new AbortController();
    let executionId = '';
    return new Promise<string>((resolve, reject) => {
      const runPromise = runWorkflow(workflow, allNodes, {
        storage: this.storage,
        triggerData,
        singleNode: options?.singleNode,
        triggerName: options?.trigger,
        signal: controller.signal,
        warn: (msg) => this.logger?.warn(msg),
        onExecutionStart: (id) => {
          executionId = id;
          this.running.set(id, controller);
          resolve(id);
        },
        onStep: (step) => {
          this.emit(executionId, { type: 'step', executionId, step });
        },
      });
      this.inFlight.add(runPromise);
      runPromise
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
        })
        .finally(() => {
          this.inFlight.delete(runPromise);
          if (executionId) this.running.delete(executionId);
        });
    });
  }

  /** Stop a run in flight. True when a run was found and signalled. */
  cancel(executionId: string): boolean {
    const controller = this.running.get(executionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** How many runs are in flight right now. */
  activeCount(): number {
    return this.running.size;
  }

  /**
   * Wait for the runs in flight to finish, so a shutdown does not kill a
   * run mid-write. Gives up after `timeoutMs` (default 30 s) and lets the
   * shutdown proceed.
   */
  async waitForIdle(timeoutMs = 30000): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
