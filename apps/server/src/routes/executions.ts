// Execution routes: run history, newest first, and one run with its steps.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function registerExecutionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/executions', async (req) => {
    const query = req.query as Record<string, unknown>;
    const workflowId =
      typeof query.workflowId === 'string' ? query.workflowId : undefined;
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
      : 50;
    return ctx.storage.listExecutions(workflowId, limit);
  });

  app.get('/api/executions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const execution = ctx.storage.getExecution(id);
    if (!execution) {
      reply.code(404);
      return { error: 'No run with that id.' };
    }
    return { execution, steps: ctx.storage.listSteps(id) };
  });
}
