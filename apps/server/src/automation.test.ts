// Automation end to end: the Phase 3 promise. A webhook workflow
// answers a request only while Active, saving assigns its address, a
// bad schedule is refused at save time, and a scheduled workflow runs
// on its own without anyone pressing Run.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createStorage,
  type Storage,
  type Workflow,
  type WorkflowStore,
} from '@soldar/engine';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

function webhookWorkflow(id: string, path: string): Workflow {
  return {
    id,
    name: 'Hooked',
    active: false,
    nodes: [
      {
        id: 'n1',
        type: 'webhook-trigger',
        name: 'Hook',
        position: [100, 100],
        parameters: { path },
      },
      {
        id: 'n2',
        type: 'set',
        name: 'Read it',
        position: [320, 100],
        parameters: { values: [{ name: 'seen', value: '{{ $json.body.hello }}' }] },
      },
    ],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

function scheduledWorkflow(id: string, cron: string): Workflow {
  return {
    id,
    name: 'Clocked',
    active: false,
    nodes: [
      {
        id: 'n1',
        type: 'schedule-trigger',
        name: 'Clock',
        position: [100, 100],
        parameters: { cron },
      },
      {
        id: 'n2',
        type: 'set',
        name: 'Stamp',
        position: [320, 100],
        parameters: { values: [{ name: 'ran', value: 'yes' }] },
      },
    ],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

async function createAndSave(
  app: FastifyInstance,
  build: (id: string) => Workflow,
): Promise<{ id: string; saved: Workflow }> {
  const created = await app.inject({ method: 'POST', url: '/api/workflows', payload: {} });
  const id = (created.json() as { id: string }).id;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/workflows/${id}`,
    payload: build(id) as unknown as Record<string, unknown>,
  });
  expect(res.statusCode).toBe(200);
  return { id, saved: (res.json() as { workflow: Workflow }).workflow };
}

async function setActive(app: FastifyInstance, id: string, active: boolean): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/workflows/${id}/active`,
    payload: { active },
  });
  expect(res.statusCode).toBe(200);
}

describe('automation', () => {
  let dir: string;
  let storage: Storage & WorkflowStore;
  let app: FastifyInstance & { scheduler: { jobCount: (id: string) => number } };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-automation-test-'));
    storage = createStorage(join(dir, 'test.db'));
    const logger = createLogger(join(dir, 'test.log'));
    app = (await createApp({ storage, logger, logPath: join(dir, 'test.log') })) as typeof app;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a random webhook address ending at save time', async () => {
    const { saved } = await createAndSave(app, (id) => webhookWorkflow(id, ''));
    const node = saved.nodes.find((n) => n.type === 'webhook-trigger')!;
    expect(typeof node.parameters.path).toBe('string');
    expect((node.parameters.path as string).length).toBeGreaterThanOrEqual(16);
  });

  it('keeps a webhook address ending the user typed', async () => {
    const { saved } = await createAndSave(app, (id) => webhookWorkflow(id, 'my-hook'));
    const node = saved.nodes.find((n) => n.type === 'webhook-trigger')!;
    expect(node.parameters.path).toBe('my-hook');
  });

  it('refuses an address ending that cannot work in an address', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', payload: {} });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: webhookWorkflow(id, 'not a path!') as unknown as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('will not work in an address');
  });

  it('refuses a schedule that does not parse, at save time', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', payload: {} });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: scheduledWorkflow(id, 'banana') as unknown as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('does not parse');
  });

  it('answers a webhook only while Active, and the request data flows through', async () => {
    const { id, saved } = await createAndSave(app, (wid) => webhookWorkflow(wid, ''));
    const path = saved.nodes.find((n) => n.type === 'webhook-trigger')!.parameters
      .path as string;

    const inactive = await app.inject({
      method: 'POST',
      url: `/webhook/${path}`,
      payload: { hello: 'world' },
    });
    expect(inactive.statusCode).toBe(404);

    await setActive(app, id, true);
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/${path}`,
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; executionId: string; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('success');

    const execution = storage.getExecution(body.executionId);
    expect(execution?.trigger).toBe('webhook');
    const steps = storage.listSteps(body.executionId);
    const setStep = steps.find((s) => s.nodeName === 'Read it')!;
    expect(JSON.parse(setStep.outputJson)).toEqual({
      main: [{ json: { body: { hello: 'world' }, query: {}, method: 'POST', seen: 'world' } }],
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/webhook/no-such-address',
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it(
    'runs a scheduled workflow on its own once it is Active',
    async () => {
      const { id } = await createAndSave(app, (wid) =>
        scheduledWorkflow(wid, '* * * * * *'),
      );
      expect(app.scheduler.jobCount(id)).toBe(0);
      await setActive(app, id, true);
      expect(app.scheduler.jobCount(id)).toBe(1);

      const deadline = Date.now() + 8000;
      let executions = storage.listExecutions(id);
      while (executions.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        executions = storage.listExecutions(id);
      }
      expect(executions.length).toBeGreaterThanOrEqual(1);
      expect(executions[0].trigger).toBe('schedule');
      expect(executions[0].status).toBe('success');

      await setActive(app, id, false);
      expect(app.scheduler.jobCount(id)).toBe(0);
    },
    15000,
  );
});
