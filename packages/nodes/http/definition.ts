import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { NodeDefinition } from '@soldar/engine';
import { scrubResponseHeaders, stripUrlQuery } from '@soldar/engine';
import { createPinnedLookup, resolveCheckedAddresses } from './ssrf.js';

interface HeaderEntry {
  name: string;
  value: string;
}

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TIMEOUT_MS = 300000; // 5 minutes
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The response grew past the size cap — a plain error, not a fetch failure. */
class ResponseTooLargeError extends Error {}

interface CheckedResponse {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * One HTTP request, over node:http/https (not global fetch) so the socket
 * connects to exactly the addresses the SSRF guard checked: the pinned
 * lookup answers with those addresses and never consults real DNS, which
 * closes the check-then-fetch hole where a hostile DNS could swap the
 * answer between the check and the fetch. When `pinnedAddresses` is null
 * (the workflow opted out of the guard) normal DNS is used. The Host
 * header and TLS certificate checks still use the real hostname.
 */
function requestOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  pinnedAddresses: string[] | null,
): Promise<CheckedResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    };
    const succeed = (value: CheckedResponse): void => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };

    const req = doRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? undefined : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(pinnedAddresses ? { lookup: createPinnedLookup(pinnedAddresses) } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            fail(
              new ResponseTooLargeError(
                `Response from ${stripUrlQuery(url)} was larger than the 10 MB cap.`,
              ),
            );
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const headerEntries: [string, string][] = [];
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) headerEntries.push([name, v]);
            } else {
              headerEntries.push([name, value]);
            }
          }
          succeed({
            status: res.statusCode ?? 0,
            headers: new Headers(headerEntries),
            text: async () => text,
          });
        });
        res.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      },
    );
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Fetch with manual redirect handling: every hop is re-checked by the SSRF
 * guard (and fetched through the pinned addresses from that check), so a
 * public URL cannot redirect the request onto the local network. A
 * redirect to another site drops the Authorization and Cookie headers, so
 * a workflow's credentials never leak to a stranger's server.
 */
async function fetchChecked(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<CheckedResponse> {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  let currentHeaders = { ...headers };
  for (let redirects = 0; ; redirects++) {
    // Resolve and check once per hop; the fetch below connects to exactly
    // these addresses. A DNS failure throws here with a plain message
    // instead of surfacing as a timeout later.
    const pinned = allowPrivate
      ? null
      : await resolveCheckedAddresses(currentUrl, { allowPrivate });
    let response: CheckedResponse;
    try {
      response = await requestOnce(
        currentUrl,
        currentMethod,
        currentHeaders,
        currentBody,
        timeoutMs,
        pinned,
      );
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err;
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new Error(`Request to ${stripUrlQuery(currentUrl)} timed out after ${timeoutMs} ms.`);
      }
      throw new Error(
        `Request to ${stripUrlQuery(currentUrl)} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) while fetching ${stripUrlQuery(url)}.`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      const stripped: Record<string, string> = {};
      for (const [name, value] of Object.entries(currentHeaders)) {
        const lower = name.toLowerCase();
        if (lower !== 'authorization' && lower !== 'cookie') {
          stripped[name] = value;
        }
      }
      currentHeaders = stripped;
    }
    currentUrl = nextUrl;
    // 303 always becomes GET; 301/302 turn a POST into a GET.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
    ) {
      currentMethod = 'GET';
      currentBody = undefined;
    }
  }
}

/**
 * HTTP Request — GET/POST to any URL, with headers and a body. The SSRF
 * guard refuses private/local addresses unless the workflow opts out with
 * settings.allowPrivateAddresses: true. An HTTP status of 400 or above
 * fails the node, so the run stops with the status in the error.
 */
export const httpNode: NodeDefinition = {
  type: 'http',
  displayName: 'HTTP Request',
  description: 'GET/POST to any URL, with headers and a body.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2 a15.3 15.3 0 0 1 0 20 a15.3 15.3 0 0 1 0 -20 Z"/></svg>',
  inputs: 1,
  outputs: ['main'],
  parameters: [
    {
      name: 'method',
      displayName: 'Method',
      type: 'options',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
        { label: 'PATCH', value: 'PATCH' },
        { label: 'DELETE', value: 'DELETE' },
      ],
      default: 'GET',
    },
    {
      name: 'url',
      displayName: 'URL',
      type: 'string',
      required: true,
      description: 'May contain {{ }} expressions.',
    },
    {
      name: 'headers',
      displayName: 'Headers',
      type: 'keyValue',
      description: 'One row per header.',
      default: [],
    },
    {
      name: 'body',
      displayName: 'Body',
      type: 'string',
      description: 'Sent as the request body. JSON is sent as application/json.',
      default: '',
    },
    {
      name: 'timeoutMs',
      displayName: 'Timeout (ms)',
      type: 'number',
      default: 30000,
    },
  ],
  async execute(ctx) {
    const method = String(ctx.params.method ?? 'GET').toUpperCase();
    const url = String(ctx.params.url ?? '');
    if (url === '') {
      throw new Error('HTTP node needs a URL.');
    }
    const headers: Record<string, string> = {};
    const headerList = (Array.isArray(ctx.params.headers) ? ctx.params.headers : []) as HeaderEntry[];
    for (const entry of headerList) {
      if (entry && typeof entry.name === 'string' && entry.name !== '') {
        headers[entry.name] = String(entry.value ?? '');
      }
    }
    let timeoutMs =
      typeof ctx.params.timeoutMs === 'number' ? ctx.params.timeoutMs : 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        'HTTP timeout must be a positive number of milliseconds, not ' +
          `${String(ctx.params.timeoutMs)}.`,
      );
    }
    // A huge timeout is the same as no timeout; cap it at five minutes.
    if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
    const allowPrivate = ctx.workflow.settings?.allowPrivateAddresses === true;

    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const rawBody = String(ctx.params.body ?? '');
      if (rawBody !== '') {
        body = rawBody;
        const hasContentType = Object.keys(headers).some(
          (k) => k.toLowerCase() === 'content-type',
        );
        if (!hasContentType) {
          try {
            const parsed: unknown = JSON.parse(rawBody);
            if (parsed !== null && typeof parsed === 'object') {
              headers['Content-Type'] = 'application/json';
            }
          } catch {
            // Not JSON — send it as-is.
          }
        }
      }
    }

    const response = await fetchChecked(url, method, headers, body, timeoutMs, allowPrivate);

    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      const text = await response.text();
      try {
        responseBody = text === '' ? null : (JSON.parse(text) as unknown);
      } catch {
        responseBody = text;
      }
    } else {
      responseBody = await response.text();
    }

    if (response.status >= 400) {
      const detail =
        typeof responseBody === 'string'
          ? truncate(responseBody, 200)
          : truncate(JSON.stringify(responseBody), 200);
      throw new Error(`HTTP ${response.status} from ${stripUrlQuery(url)}${detail ? `: ${detail}` : ''}`);
    }

    return {
      main: [
        {
          json: {
            status: response.status,
            headers: scrubResponseHeaders(response.headers),
            body: responseBody,
          },
        },
      ],
    };
  },
};
