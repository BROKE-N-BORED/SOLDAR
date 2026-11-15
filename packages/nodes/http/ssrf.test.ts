import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isPrivateIp } from './ssrf.js';

describe('isPrivateIp', () => {
  const cases: [string, boolean][] = [
    // IPv4 — private and special ranges
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['169.254.1.1', true],
    ['0.0.0.0', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['192.0.2.1', true],
    ['198.51.100.1', true],
    ['203.0.113.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    // IPv4 — public
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false],
    ['100.128.0.1', false],
    ['11.0.0.1', false],
    // IPv6 — private and special ranges
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['febf::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['2001:db8::1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:127.0.0.1', true],
    // IPv6 — public
    ['::ffff:8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    ['2606:4700:4700::1111', false],
  ];
  it.each(cases)('%s -> %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it('returns false for hostnames', () => {
    expect(isPrivateIp('example.com')).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  it('allows a public URL', async () => {
    await expect(
      assertUrlAllowed('https://example.com/api', {
        resolveHost: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a literal private IP without needing DNS', async () => {
    await expect(assertUrlAllowed('http://192.168.1.1/admin')).rejects.toThrow(
      'SSRF guard blocks local network addresses',
    );
    await expect(assertUrlAllowed('http://127.0.0.1:8080/')).rejects.toThrow(
      'private address 127.0.0.1',
    );
    await expect(assertUrlAllowed('http://10.0.0.5/')).rejects.toThrow('private address');
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toThrow('private address');
  });

  it('catches obfuscated IPv4 forms the URL parser normalizes', async () => {
    await expect(assertUrlAllowed('http://2130706433/')).rejects.toThrow('private address');
    await expect(assertUrlAllowed('http://127.1/')).rejects.toThrow('private address');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(
      assertUrlAllowed('https://evil.example.com/', {
        resolveHost: async () => ['93.184.216.34', '169.254.169.254'],
      }),
    ).rejects.toThrow('private address 169.254.169.254');
  });

  it('allows the opt-out', async () => {
    await expect(
      assertUrlAllowed('http://192.168.1.1/admin', { allowPrivate: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertUrlAllowed('http://localhost:3000/', { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it('refuses non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('ftp://example.com/')).rejects.toThrow(
      'Only http and https URLs are allowed',
    );
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(
      'Only http and https URLs are allowed',
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('not a url at all')).rejects.toThrow('not a valid URL');
  });

  it('reports an unresolvable host plainly', async () => {
    await expect(
      assertUrlAllowed('https://no-such-host.invalid/', {
        resolveHost: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow('Could not resolve host "no-such-host.invalid"');
  });
});
