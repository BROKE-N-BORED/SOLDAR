// Redact things that look like secrets from text headed for logs, error
// messages, and stored step data. The patterns cover the shapes secrets
// actually take in this app: query parameters, Bearer tokens, and
// Authorization headers. User data flowing through a workflow is NOT
// scrubbed — only the app's own messages and stored headers are.

/** Query parameter names that carry secrets. */
const SECRET_PARAMS = [
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'token',
  'secret',
  'password',
  'auth',
];

/** Redact secret-looking values from a log line or error message. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const param of SECRET_PARAMS) {
    out = out.replace(
      new RegExp(`((?:^|[?&])${param}=)[^&\\s"']*`, 'gi'),
      '$1[redacted]',
    );
  }
  // Authorization headers first: the whole value goes, whatever the scheme
  // (Bearer, Basic, ...), so a bare-Bearer pass afterwards never sees it.
  out = out.replace(
    /(authorization:\s*)(?:[A-Za-z]+\s+)?[^\s"',}]+/gi,
    '$1[redacted]',
  );
  // Bare Bearer tokens, not part of an Authorization header.
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer [redacted]');
  return out;
}

/**
 * A URL safe to put in an error message: origin + path, no query string
 * (query strings can carry API keys). Falls back to the raw string when
 * the URL does not parse.
 */
export function stripUrlQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Response headers safe to store: cookies and auth are redacted, since a
 * Set-Cookie can carry a live session. The header names stay, so the run
 * still shows what came back.
 */
export function scrubResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    out[name] = lower === 'set-cookie' || lower === 'authorization' ? '[redacted]' : value;
  }
  return out;
}
