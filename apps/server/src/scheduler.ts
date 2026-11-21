// The scheduler: keeps one cron job per Schedule Trigger node in every
// Active workflow, and starts a run when a job fires. Jobs are rebuilt
// from the stored workflows on server start (so Active workflows resume
// after a restart) and whenever a workflow is saved, toggled, or deleted.

import { Cron } from 'croner';
import {
  validateWorkflow,
  type Storage,
  type Workflow,
  type WorkflowStore,
} from '@soldar/engine';
import { allNodes } from '@soldar/nodes';
import type { Logger } from './logger.js';
import { RunServiceBusyError, type RunService } from './run-service.js';

/** True when the value is a cron pattern the scheduler can actually run. */
export function isValidCronPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string' || pattern.trim() === '') return false;
  try {
    const job = new Cron(pattern, { paused: true }, () => {});
    job.stop();
    return true;
  } catch {
    return false;
  }
}

export class SchedulerService {
  /** Cron jobs by workflow id (a workflow can hold several schedules). */
  private jobs = new Map<string, Cron[]>();

  constructor(
    private storage: Storage & WorkflowStore,
    private runs: RunService,
    private logger?: Logger,
  ) {}

  /** Register schedules for every stored workflow. Called once at startup. */
  syncAll(): void {
    for (const record of this.storage.listWorkflows()) {
      this.syncWorkflow(record.id);
    }
  }

  /**
   * Rebuild one workflow's jobs from its stored state. Inactive or
   * schedule-free workflows end up with no jobs. A schedule whose
   * pattern does not parse is logged and skipped, never fatal.
   */
  syncWorkflow(workflowId: string): void {
    this.removeWorkflow(workflowId);
    const record = this.storage.getWorkflow(workflowId);
    if (!record || !record.active) return;
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      this.logger?.error(
        `Scheduler: workflow ${workflowId} is damaged and could not be read, so its schedules are off.`,
      );
      return;
    }
    const jobs: Cron[] = [];
    for (const node of workflow.nodes) {
      if (node.type !== 'schedule-trigger') continue;
      const pattern = node.parameters?.cron;
      if (!isValidCronPattern(pattern)) {
        this.logger?.warn(
          `Scheduler: workflow "${record.name}" node "${node.name}" has a schedule that does not parse (${JSON.stringify(pattern)}), so that schedule will not run. Fix the pattern in the node's settings.`,
        );
        continue;
      }
      jobs.push(
        new Cron(pattern, () => {
          void this.fire(workflowId, node.name);
        }),
      );
    }
    if (jobs.length > 0) {
      this.jobs.set(workflowId, jobs);
      this.logger?.info(
        `Scheduler: workflow "${record.name}" has ${jobs.length} active schedule${jobs.length === 1 ? '' : 's'}.`,
      );
    }
  }

  /** Stop and forget one workflow's jobs. */
  removeWorkflow(workflowId: string): void {
    const jobs = this.jobs.get(workflowId);
    if (!jobs) return;
    for (const job of jobs) job.stop();
    this.jobs.delete(workflowId);
  }

  /** Stop every job. Called when the server closes. */
  stopAll(): void {
    for (const id of [...this.jobs.keys()]) this.removeWorkflow(id);
  }

  /** How many schedules are registered for a workflow (tests, diagnostics). */
  jobCount(workflowId: string): number {
    return this.jobs.get(workflowId)?.length ?? 0;
  }

  private async fire(workflowId: string, nodeName: string): Promise<void> {
    const record = this.storage.getWorkflow(workflowId);
    if (!record || !record.active) {
      // Toggled off or deleted between registration and firing.
      this.removeWorkflow(workflowId);
      return;
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
      validateWorkflow(workflow, allNodes);
    } catch (err) {
      this.logger?.error(
        `Scheduler: workflow "${record.name}" could not run on its schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    try {
      const executionId = await this.runs.start(
        workflow,
        [
          {
            json: {
              firedAt: new Date().toISOString(),
              trigger: 'schedule',
              node: nodeName,
            },
          },
        ],
        { trigger: 'schedule' },
      );
      this.logger?.info(
        `Scheduler: run ${executionId} started for workflow "${record.name}" (schedule node "${nodeName}").`,
      );
    } catch (err) {
      if (err instanceof RunServiceBusyError) {
        this.logger?.warn(
          `Scheduler: skipped a scheduled run of "${record.name}": two runs are already going.`,
        );
      } else {
        this.logger?.error(
          `Scheduler: a scheduled run of "${record.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
