import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Item, NodeContext } from '@soldar/engine';
import { httpNode } from './definition.js';

// A tiny local echo server. The SSRF guard blocks 127.0.0.1 by default, so
// tests that hit it run with the workflow opt-out turned on — except the
// guard tests, which prove the refusal.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    if (req.url === '/not-found') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          echoHeader: req.headers['x-test-header'] ?? null,
          contentType: req.headers['content-type'] ?? null,
          body,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function ctx(
  params: Record<string, unknown>,
  allowPrivate = true,
): NodeContext {
  return {
    input: [{ json: {} }] as Item[],
    params,
    credentials: async () => {
      throw new Error('no credentials in Phase 1');
    },
    log: () => {},
    workflow: {
      id: 'wf',
      name: 'Test',
      settings: { allowPrivateAddresses: allowPrivate },
    },
  };
}

describe('http', () => {
  it('GETs JSON and returns status, headers, and parsed body', async () => {
    const out = await httpNode.execute(ctx({ method: 'GET', url: `${base}/final` }));
    const json = out.main[0].json;
    expect(json.status).toBe(200);
    const body = json.body as Record<string, unknown>;
    expect(body.method).toBe('GET');
    expect(body.path).toBe('/final');
    expect(json.headers).toBeDefined();
  });

  it('POSTs a JSON body with the right content type and headers', async () => {
    const out = await httpNode.execute(
      ctx({
        method: 'POST',
        url: `${base}/final`,
        headers: [{ name: 'X-Test-Header', value: 'yes' }],
        body: '{"hello":"world"}',
      }),
    );
    const body = out.main[0].json.body as Record<string, unknown>;
    expect(body.method).toBe('POST');
    expect(body.body).toBe('{"hello":"world"}');
    expect(body.echoHeader).toBe('yes');
    expect(body.contentType).toBe('application/json');
  });

  it('follows redirects', async () => {
    const out = await httpNode.execute(ctx({ method: 'GET', url: `${base}/redirect` }));
    const body = out.main[0].json.body as Record<string, unknown>;
    expect(body.path).toBe('/final');
  });

  it('fails the node on an HTTP error status', async () => {
    await expect(
      httpNode.execute(ctx({ method: 'GET', url: `${base}/not-found` })),
    ).rejects.toThrow('HTTP 404');
  });

  it('refuses a local address when the workflow has not opted out', async () => {
    await expect(
      httpNode.execute(ctx({ method: 'GET', url: `${base}/final` }, false)),
    ).rejects.toThrow('SSRF guard blocks local network addresses');
  });

  it('throws a plain error with no URL', async () => {
    await expect(httpNode.execute(ctx({ method: 'GET', url: '' }))).rejects.toThrow(
      'needs a URL',
    );
  });
});
