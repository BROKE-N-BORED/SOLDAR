import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  createPinnedLookup,
  isPrivateIp,
  resolveCheckedAddresses,
} from './ssrf.js';

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
    ['198.18.0.1', true],
    ['198.19.255.255', true],
    ['203.0.113.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    // IPv4 — public
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false],
    ['198.20.0.1', false],
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

  it('phrases the refusal without an em-dash and names the fix', async () => {
    const err = await assertUrlAllowed('http://127.0.0.1:8080/').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe(
      'Refused to call 127.0.0.1. It resolves to private address 127.0.0.1, and the ' +
        'SSRF guard blocks local network addresses. Set settings.allowPrivateAddresses ' +
        'to true on the workflow to allow it.',
    );
    expect(message).not.toContain('—');
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

describe('resolveCheckedAddresses', () => {
  it('returns the checked addresses for a public hostname', async () => {
    const addresses = await resolveCheckedAddresses('https://example.com/api', {
      resolveHost: async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    });
    expect(addresses).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
  });

  it('returns the literal for a public IP hostname', async () => {
    await expect(resolveCheckedAddresses('http://8.8.8.8/')).resolves.toEqual(['8.8.8.8']);
  });

  it('returns [] when the workflow opted out', async () => {
    await expect(
      resolveCheckedAddresses('http://192.168.1.1/', { allowPrivate: true }),
    ).resolves.toEqual([]);
  });
});

describe('createPinnedLookup', () => {
  it('answers with the pinned address, never real DNS', async () => {
    const lookup = createPinnedLookup(['93.184.216.34']);
    // A hostname that does not exist in DNS at all still resolves to the
    // pinned address — the lookup never consults the resolver.
    const address = await new Promise<string>((resolve, reject) => {
      lookup('does-not-exist.invalid', {}, (err, addr) => {
        if (err) reject(err);
        else resolve(addr as string);
      });
    });
    expect(address).toBe('93.184.216.34');
  });

  it('answers all-addresses lookups with the full pinned list', async () => {
    const lookup = createPinnedLookup([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
    const addresses = await new Promise<{ address: string; family: number }[]>(
      (resolve, reject) => {
        lookup('example.com', { all: true }, (err, addr) => {
          if (err) reject(err);
          else resolve(addr as { address: string; family: number }[]);
        });
      },
    );
    expect(addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });
});
