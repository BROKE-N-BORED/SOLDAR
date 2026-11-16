// API tests: Fastify inject for the REST routes (no port needed), plus one
// real-socket test for the WebSocket run stream.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createStorage, type Workflow } from '@soldar/engine';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const SLOW_CODE = 'let x = 0; for (let i = 0; i < 200000000; i++) x += i; return items;';

function twoNodeWorkflow(id: string): Workflow {
  return {
    id,
    name: 'Hello',
    active: false,
    nodes: [
      { id: 'n1', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n2',
        type: 'set',
        name: 'Greet',
        position: [320, 100],
        parameters: { values: [{ name: 'greeting', value: 'Hello from Soldar' }] },
      },
    ],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

describe('server API', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'soldar-server-test-'));
    const storage = createStorage(join(dir, 'test.db'));
    const logger = createLogger(join(dir, 'test.log'));
    app = await createApp({ storage, logger, logPath: join(dir, 'test.log') });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers health and lists the node catalogue', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const nodes = await app.inject({ method: 'GET', url: '/api/nodes' });
    expect(nodes.statusCode).toBe(200);
    const list = nodes.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(5);
    const types = list.map((n) => n.type).sort();
    expect(types).toEqual(['code', 'http', 'if', 'manual-trigger', 'set']);
    for (const node of list) {
      expect(node).not.toHaveProperty('execute');
      expect(Array.isArray(node.parameters)).toBe(true);
    }
  });

  it('creates, reads, lists, updates, toggles, and deletes workflows', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; name: string; workflow: Workflow };
    expect(body.name).toBe('Untitled workflow');
    expect(body.workflow.nodes).toEqual([]);

    const listed = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(listed.json()).toHaveLength(1);

    const read = await app.inject({ method: 'GET', url: `/api/workflows/${body.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().workflow.id).toBe(body.id);

    const workflow = twoNodeWorkflow(body.id);
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${body.id}`,
      payload: workflow,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().nodeCount).toBe(2);

    const toggled = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${body.id}/active`,
      payload: { active: true },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().active).toBe(true);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/workflows/${body.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/workflows/${body.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects bad workflow saves with a plain error', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Bad' },
    });
    const { id } = created.json() as { id: string };

    // A cycle.
    const cyclic = twoNodeWorkflow(id);
    cyclic.connections.push({ from: 'n2', to: 'n1' });
    const cyclicRes = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: cyclic,
    });
    expect(cyclicRes.statusCode).toBe(400);
    expect(typeof cyclicRes.json().error).toBe('string');

    // A dangling connection.
    const dangling = twoNodeWorkflow(id);
    dangling.connections.push({ from: 'n2', to: 'n99' });
    const danglingRes = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: dangling,
    });
    expect(danglingRes.statusCode).toBe(400);

    // Not a workflow at all.
    const junk = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: { hello: 'world' },
    });
    expect(junk.statusCode).toBe(400);

    // An empty workflow is a valid draft to save.
    const empty = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: { id, name: 'Bad', active: false, nodes: [], connections: [] },
    });
    expect(empty.statusCode).toBe(200);

    // But an empty workflow cannot run.
    const run = await app.inject({ method: 'POST', url: `/api/workflows/${id}/run` });
    expect(run.statusCode).toBe(400);
  });

  it('runs a workflow through the API and records the run', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Hello' },
    });
    const { id } = created.json() as { id: string };
    await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: twoNodeWorkflow(id),
    });

    const run = await app.inject({ method: 'POST', url: `/api/workflows/${id}/run` });
    expect(run.statusCode).toBe(202);
    const { executionId } = run.json() as { executionId: string };
    expect(executionId).toMatch(/^exec_/);

    // The run finishes in the background; poll until it lands.
    let detail: { execution: { status: string }; steps: Array<Record<string, unknown>> } | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/executions/${executionId}` });
      detail = res.json();
      if (detail!.execution.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail!.execution.status).toBe('success');
    expect(detail!.steps).toHaveLength(2);
    expect(detail!.steps[0].status).toBe('success');
    const output = JSON.parse(detail!.steps[1].outputJson as string) as {
      main: Array<{ json: Record<string, unknown> }>;
    };
    expect(output.main[0].json.greeting).toBe('Hello from Soldar');

    const history = await app.inject({
      method: 'GET',
      url: `/api/executions?workflowId=${id}`,
    });
    expect(history.json()).toHaveLength(1);
    const other = await app.inject({
      method: 'GET',
      url: '/api/executions?workflowId=wf_nope',
    });
    expect(other.json()).toHaveLength(0);
  });

  it('serves the debug log', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/debug-log' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('string');
  });

  // Deliberately slow: the Code node burns ~2-5 s so the stream has time to
  // deliver a mid-run step. Generous timeout so a loaded machine still passes.
  it('streams live progress over WebSocket', { timeout: 30000 }, async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Slow' },
    });
    const { id } = created.json() as { id: string };
    const workflow: Workflow = {
      id,
      name: 'Slow',
      active: false,
      nodes: [
        { id: 'n1', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
        {
          id: 'n2',
          type: 'code',
          name: 'Slow step',
          position: [320, 100],
          parameters: { code: SLOW_CODE },
        },
      ],
      connections: [{ from: 'n1', to: 'n2' }],
    };
    await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, payload: workflow });
    const run = await app.inject({ method: 'POST', url: `/api/workflows/${id}/run` });
    const { executionId } = run.json() as { executionId: string };

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const messages: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for done.')), 20000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', executionId }));
      });
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === 'done') {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket error.'));
      });
    });
    ws.close();

    const snapshot = messages.find((m) => m.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.executionId).toBe(executionId);
    const done = messages.find((m) => m.type === 'done');
    expect(done).toBeDefined();
    expect((done!.execution as { status: string }).status).toBe('success');
    // The slow node should have produced a live step event, not just the snapshot.
    const liveSteps = messages.filter((m) => m.type === 'step');
    expect(liveSteps.length).toBeGreaterThanOrEqual(1);
    const codeStep = liveSteps.find(
      (m) => (m.step as { nodeId: string }).nodeId === 'n2',
    );
    expect(codeStep).toBeDefined();
    expect((codeStep!.step as { status: string }).status).toBe('success');
  });
});
