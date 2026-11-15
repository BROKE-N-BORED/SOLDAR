import type { NodeDefinition } from '@soldar/engine';
import { assertUrlAllowed } from './ssrf.js';

interface HeaderEntry {
  name: string;
  value: string;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Fetch with manual redirect handling: every hop is re-checked by the SSRF
 * guard, so a public URL cannot redirect the request onto the local network.
 */
async function fetchChecked(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<Response> {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  for (let redirects = 0; ; redirects++) {
    await assertUrlAllowed(currentUrl, { allowPrivate });
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Request to ${currentUrl} timed out after ${timeoutMs} ms.`);
      }
      throw new Error(
        `Request to ${currentUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) while fetching ${url}.`);
    }
    currentUrl = new URL(location, currentUrl).toString();
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
    const timeoutMs =
      typeof ctx.params.timeoutMs === 'number' ? ctx.params.timeoutMs : 30000;
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
      throw new Error(`HTTP ${response.status} from ${url}${detail ? `: ${detail}` : ''}`);
    }

    return {
      main: [
        {
          json: {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
          },
        },
      ],
    };
  },
};
