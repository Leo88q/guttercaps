import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { readGateway } from '../src/switchboard-gateway.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
let status: number, body: string, socketAddress: string | undefined, requestedPath: string | undefined;
let requestBody: string | undefined;
beforeEach(() => {
  status = 200; body = '{"oracles":[]}'; socketAddress = undefined; requestBody = undefined;
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  vi.mocked(request).mockImplementation(((url: URL, opts: { lookup: Function; autoSelectFamily: boolean }, callback: Function) => {
    requestedPath = url.pathname;
    expect(opts.autoSelectFamily).toBe(false);
    const req = Object.assign(new EventEmitter(), {
      destroy: (e: Error) => { req.emit('error', e); req.emit('close'); },
      end: (data: string) => {
        requestBody = data;
        opts.lookup(url.hostname, {}, (err: Error | null, address: string) => {
          if (err) { req.destroy(err); return; }
          socketAddress = address;
          const res = Object.assign(new EventEmitter(), { statusCode: status, destroy: () => req.emit('close') });
          callback(res);
          if (status === 200) { res.emit('data', Buffer.from(body)); res.emit('end'); req.emit('close'); }
        });
      },
    });
    return req;
  }) as never);
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
it('pins the validated DNS address, retains the HTTPS hostname, and uses a fixed path', async () => {
  expect(await readGateway('https://oracle.example.com', 'healthy_oracles')).toEqual({ oracles: [] });
  expect(socketAddress).toBe('8.8.8.8'); expect(requestedPath).toBe('/gateway/api/v1/healthy_oracles');
  expect(requestBody).toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(1);
});
it('rejects mixed public/private DNS answers before opening a socket', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }] as never);
  await expect(readGateway('https://oracle.example.com', 'healthy_oracles')).rejects.toMatchObject({ code: 'unsafe_gateway' });
  expect(socketAddress).toBeUndefined();
});
it('does not follow redirects or expose gateway response prose', async () => {
  status = 302; body = 'https://private.invalid?api-key=SECRET';
  await expect(readGateway('https://oracle.example.com', 'randomness_reveal', { slot: 1 })).rejects.toMatchObject({ message: 'gateway_http_302' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('classifies DNS errors without leaking provider messages', async () => {
  vi.mocked(lookup).mockRejectedValue(new Error('PRIVATE'));
  await expect(readGateway('https://oracle.example.com', 'healthy_oracles')).rejects.toMatchObject({ code: 'gateway_dns', message: 'gateway_dns' });
});
it('bounds the entire request including a hung DNS resolver', async () => {
  vi.useFakeTimers(); vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
  const result = readGateway('https://oracle.example.com', 'healthy_oracles');
  const assertion = expect(result).rejects.toMatchObject({ code: 'gateway_timeout' });
  await vi.advanceTimersByTimeAsync(8000); await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects oversized and non-JSON responses', async () => {
  body = 'x'.repeat(256 * 1024 + 1);
  await expect(readGateway('https://oracle.example.com', 'healthy_oracles')).rejects.toMatchObject({ code: 'gateway_payload_too_large' });
  body = 'not json';
  await expect(readGateway('https://oracle.example.com', 'healthy_oracles')).rejects.toMatchObject({ code: 'gateway_schema' });
});
