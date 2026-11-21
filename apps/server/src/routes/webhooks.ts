// Webhook routes: POST or GET /webhook/<path> starts the Active
// workflow whose Webhook Trigger node carries that path, with the
// request as the trigger data. The route waits for the run to finish
// (up to 30 seconds) so the caller gets a real answer, not just an
// acknowledgement.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validateWorkflow, type Workflow } from '@soldar/engine';
import type { RouteContext } from './context.js';
import { RunServiceBusyError } from '../run-service.js';

const WAIT_LIMIT_MS = 30_000;
const POLL_MS = 100;

/** The Active workflow (and node) listening at a webhook path, if any. */
export function findWebhookWorkflow(
  ctx: RouteContext,
  path: string,
): { workflow: Workflow; nodeName: string } | null {
  for (const record of ctx.storage.listWorkflows()) {
    if (!record.active) continue;
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      continue;
    }
    const node = workflow.nodes.find(
      (n) =>
        n.type === 'webhook-trigger' &&
        typeof n.parameters?.path === 'string' &&
        n.parameters.path === path,
    );
    if (node) return { workflow, nodeName: node.name };
  }
  return null;
}

async function waitForExecution(
  ctx: RouteContext,
  executionId: string,
): Promise<{ status: string; error: string | null } | null> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const execution = ctx.storage.getExecution(executionId);
    if (!execution) return null;
    if (execution.status !== 'running') {
      return { status: execution.status, error: execution.error };
    }
    if (Date.now() >= deadline) {
      return { status: 'running', error: null };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function registerWebhookRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const handler = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { path } = req.params as { path: string };
    const found = findWebhookWorkflow(ctx, path);
    if (!found) {
      reply.code(404);
      return { error: 'No active workflow listens at this address.' };
    }
    try {
      validateWorkflow(found.workflow, ctx.definitions);
    } catch (err) {
      ctx.logger.error(
        `Webhook ${path}: workflow "${found.workflow.name}" is not valid: ${err instanceof Error ? err.message : String(err)}`,
      );
      reply.code(500);
      return { error: 'The workflow behind this address is not valid. Check the debug log.' };
    }

    const raw = req.body as unknown;
    const bodyJson: Record<string, unknown> =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : typeof raw === 'string' && raw !== ''
          ? { text: raw }
          : {};
    const item = {
      json: {
        body: bodyJson,
        query: (req.query ?? {}) as Record<string, unknown>,
        method: req.method,
      },
    };

    let executionId: string;
    try {
      executionId = await ctx.runs.start(found.workflow, [item], { trigger: 'webhook' });
    } catch (err) {
      if (err instanceof RunServiceBusyError) {
        reply.code(429);
        return { error: err.message };
      }
      ctx.logger.error(
        `Webhook ${path}: run failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      reply.code(500);
      return { error: 'The run could not be started. Check the debug log.' };
    }
    ctx.logger.info(
      `Webhook ${path}: run ${executionId} started for workflow "${found.workflow.name}".`,
    );

    const outcome = await waitForExecution(ctx, executionId);
    if (outcome === null) {
      reply.code(500);
      return { error: 'The run record could not be read back.' };
    }
    if (outcome.status === 'error') {
      reply.code(500);
      return {
        ok: false,
        executionId,
        status: 'error',
        error: outcome.error ?? 'The run failed.',
      };
    }
    return {
      ok: true,
      executionId,
      status: outcome.status,
    };
  };

  app.post('/webhook/:path', handler);
  app.get('/webhook/:path', handler);
}
