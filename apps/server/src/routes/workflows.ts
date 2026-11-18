// Workflow routes: list, create, read, save, toggle active, delete, run.
// A workflow is stored as one JSON document; the name/active columns mirror
// the same fields inside it. Saving validates the graph first, so a broken
// workflow can never be stored.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  validateWorkflow,
  WorkflowValidationError,
  type Workflow,
} from '@soldar/engine';
import type { RouteContext } from './context.js';
import { parseTriggerData } from '../trigger-data.js';
import { RunServiceBusyError } from '../run-service.js';

function newWorkflowId(): string {
  return `wf_${randomBytes(8).toString('hex')}`;
}

function isWorkflow(value: unknown): value is Workflow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.active === 'boolean' &&
    Array.isArray(w.nodes) &&
    Array.isArray(w.connections)
  );
}

function summary(record: {
  id: string;
  name: string;
  active: boolean;
  dataJson: string;
  createdAt: number;
  updatedAt: number;
}): Record<string, unknown> {
  let nodeCount = 0;
  try {
    nodeCount = (JSON.parse(record.dataJson) as Workflow).nodes.length;
  } catch {
    nodeCount = 0;
  }
  return {
    id: record.id,
    name: record.name,
    active: record.active,
    nodeCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function registerWorkflowRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/workflows', async () => {
    return ctx.storage.listWorkflows().map(summary);
  });

  app.post('/api/workflows', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : 'Untitled workflow';
    const workflow: Workflow = {
      id: newWorkflowId(),
      name,
      active: false,
      nodes: [],
      connections: [],
    };
    const record = ctx.storage.createWorkflow(workflow);
    ctx.logger.info(`Workflow created: ${record.id} "${record.name}"`);
    reply.code(201);
    return { ...summary(record), workflow };
  });

  app.get('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = ctx.storage.getWorkflow(id);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      reply.code(500);
      return { error: 'That workflow is damaged and could not be read.' };
    }
    return { ...summary(record), workflow };
  });

  app.put('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as unknown;
    if (!isWorkflow(body)) {
      reply.code(400);
      return { error: 'That is not a workflow. It needs an id, a name, nodes, and connections.' };
    }
    if (body.id !== id) {
      reply.code(400);
      return { error: 'The workflow id does not match the address.' };
    }
    if (body.name.trim() === '') {
      reply.code(400);
      return { error: 'Every workflow needs a name.' };
    }
    // Optimistic concurrency: when the editor sends the updatedAt it
    // loaded, a newer stored copy means another tab saved first, and this
    // save would silently overwrite it. (Two saves landing in the same
    // millisecond would still slip through — vanishingly rare for a
    // human-paced editor, and the next save catches it.)
    const expected = (req.body as Record<string, unknown>).expectedUpdatedAt;
    if (typeof expected === 'number') {
      const existing = ctx.storage.getWorkflow(id);
      if (existing && existing.updatedAt !== expected) {
        reply.code(409);
        return {
          error:
            'This workflow changed in another tab since you opened it. ' +
            'Reload it and save again so nothing is lost.',
        };
      }
    }
    // An empty workflow is a valid draft to save (it just cannot run yet).
    // Anything with nodes gets the full graph check.
    const isEmptyDraft = body.nodes.length === 0 && body.connections.length === 0;
    try {
      if (!isEmptyDraft) validateWorkflow(body, ctx.definitions);
    } catch (err) {
      const message =
        err instanceof WorkflowValidationError || err instanceof Error
          ? err.message
          : 'That workflow is not valid.';
      reply.code(400);
      return { error: message };
    }
    const record = ctx.storage.updateWorkflow(id, body);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    return { ...summary(record), workflow: body };
  });

  app.patch('/api/workflows/:id/active', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.active !== 'boolean') {
      reply.code(400);
      return { error: 'Active must be true or false.' };
    }
    const record = ctx.storage.setWorkflowActive(id, body.active);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    return summary(record);
  });

  app.delete('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = ctx.storage.getWorkflow(id);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    ctx.storage.deleteWorkflow(id);
    ctx.logger.info(`Workflow deleted: ${id} "${record.name}"`);
    reply.code(204);
    return;
  });

  app.post('/api/workflows/:id/duplicate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = ctx.storage.getWorkflow(id);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      reply.code(500);
      return { error: 'That workflow is damaged and could not be read.' };
    }
    const taken = new Set(ctx.storage.listWorkflows().map((w) => w.name));
    let name = `Copy of ${workflow.name}`;
    let i = 2;
    while (taken.has(name)) {
      name = `Copy of ${workflow.name} ${i}`;
      i++;
    }
    const copy: Workflow = {
      ...workflow,
      id: newWorkflowId(),
      name,
      active: false,
    };
    const created = ctx.storage.createWorkflow(copy);
    ctx.logger.info(`Workflow duplicated: ${created.id} "${created.name}" from ${id}`);
    reply.code(201);
    return { ...summary(created), workflow: copy };
  });

  app.post('/api/workflows/:id/run-node', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = ctx.storage.getWorkflow(id);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.nodeId !== 'string' || body.nodeId === '') {
      reply.code(400);
      return { error: 'Which node? Send its id as nodeId.' };
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      reply.code(500);
      return { error: 'That workflow is damaged and could not be read.' };
    }
    const node = workflow.nodes.find((n) => n.id === body.nodeId);
    if (!node) {
      reply.code(404);
      return { error: 'No node with that id in this workflow.' };
    }
    // Run just this node, alone, with the trigger data (or one empty item).
    // The run is filed under the real workflow so it shows in its history.
    const single: Workflow = { ...workflow, nodes: [node], connections: [] };
    let triggerData;
    try {
      triggerData = parseTriggerData(body.triggerData);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : 'Bad trigger data.' };
    }
    try {
      const executionId = await ctx.runs.start(single, triggerData);
      ctx.logger.info(
        `Run started: ${executionId} for node "${node.name}" in workflow ${id}`,
      );
      reply.code(202);
      return { executionId };
    } catch (err) {
      if (err instanceof RunServiceBusyError) {
        reply.code(429);
        return { error: err.message };
      }
      ctx.logger.error(
        `Run failed to start for node ${node.id} in workflow ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      reply.code(500);
      return { error: 'The run could not be started. Check the debug log.' };
    }
  });

  app.post('/api/workflows/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = ctx.storage.getWorkflow(id);
    if (!record) {
      reply.code(404);
      return { error: 'No workflow with that id.' };
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(record.dataJson) as Workflow;
    } catch {
      reply.code(500);
      return { error: 'That workflow is damaged and could not be read.' };
    }
    try {
      validateWorkflow(workflow, ctx.definitions);
    } catch (err) {
      const message =
        err instanceof WorkflowValidationError || err instanceof Error
          ? err.message
          : 'That workflow is not valid.';
      reply.code(400);
      return { error: message };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    let triggerData;
    try {
      triggerData = parseTriggerData(body.triggerData);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : 'Bad trigger data.' };
    }
    try {
      const executionId = await ctx.runs.start(workflow, triggerData);
      ctx.logger.info(`Run started: ${executionId} for workflow ${id} "${workflow.name}"`);
      reply.code(202);
      return { executionId };
    } catch (err) {
      if (err instanceof RunServiceBusyError) {
        reply.code(429);
        return { error: err.message };
      }
      ctx.logger.error(
        `Run failed to start for workflow ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      reply.code(500);
      return { error: 'The run could not be started. Check the debug log.' };
    }
  });
}
