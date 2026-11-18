// Scrub tests: secrets must not reach logs, error messages, or stored data.

import { describe, expect, it } from 'vitest';
import { scrubResponseHeaders, scrubSecrets, stripUrlQuery } from './scrub.js';

describe('scrubSecrets', () => {
  it('redacts secret query parameters but keeps the rest', () => {
    expect(
      scrubSecrets('GET https://api.example.com/data?api_key=abc123&limit=5'),
    ).toBe('GET https://api.example.com/data?api_key=[redacted]&limit=5');
    expect(scrubSecrets('token=secret&x=1')).toBe('token=[redacted]&x=1');
  });

  it('redacts Bearer tokens', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def-123')).toBe(
      'Authorization: [redacted]',
    );
    expect(scrubSecrets('token Bearer abc.def-123')).toBe(
      'token Bearer [redacted]',
    );
  });

  it('redacts an Authorization header value', () => {
    expect(scrubSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization: [redacted]',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('Request failed: connect ECONNREFUSED 127.0.0.1:5678')).toBe(
      'Request failed: connect ECONNREFUSED 127.0.0.1:5678',
    );
  });
});

describe('stripUrlQuery', () => {
  it('keeps origin and path, drops the query string', () => {
    expect(stripUrlQuery('https://api.example.com/data?api_key=abc&x=1')).toBe(
      'https://api.example.com/data',
    );
  });

  it('returns an unparsable URL unchanged', () => {
    expect(stripUrlQuery('not a url')).toBe('not a url');
  });
});

describe('scrubResponseHeaders', () => {
  it('redacts cookies and auth, keeps the rest', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'set-cookie': 'session=abc; HttpOnly',
      authorization: 'Bearer xyz',
    });
    expect(scrubResponseHeaders(headers)).toEqual({
      'content-type': 'application/json',
      'set-cookie': '[redacted]',
      authorization: '[redacted]',
    });
  });
});
