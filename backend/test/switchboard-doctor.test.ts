import { expect, it, vi } from 'vitest';
import { compareGateway, curlArgs, curlMetrics, curlReport } from '../../scripts/switchboard-doctor.mts';
import { SwitchboardError } from '../src/switchboard-gateway.ts';

it('compares the SAME full public health URL and reports partial Node progress on timeout', async () => {
  const curl = vi.fn(async () => curlMetrics('200 0.003 0.05 0.10 0.15 0.2 2', 0));
  const report = await compareGateway('https://oracle.example.com/prefix/', {
    gateway: async (base, op, body, trace) => {
      expect(base).toBe('https://oracle.example.com/prefix'); expect(op).toBe('healthy_oracles'); expect(body).toBeUndefined();
      trace?.({ stage: 'dns_start', ms: 1 }); trace?.({ stage: 'dns_done', ms: 2 }); trace?.({ stage: 'tcp', ms: 52 });
      throw new SwitchboardError('gateway_timeout');
    }, curl,
  });
  expect(curl).toHaveBeenCalledWith('https://oracle.example.com/prefix/gateway/api/v1/healthy_oracles');
  expect(report).toMatchObject({ requestPath: '/prefix/gateway/api/v1/healthy_oracles', node: { ok: false, code: 'gateway_timeout' }, curl: { httpStatus: 200, totalMs: 200 } });
  expect(report.node.stages.map(e => e.stage)).toEqual(['dns_start', 'dns_done', 'tcp']);
});
it('does not echo raw exceptions, response bodies or arbitrary curl output', async () => {
  const report = await compareGateway('https://oracle.example.com/prefix', {
    gateway: async () => { throw new Error('PRIVATE-RPC-KEY'); },
    curl: async () => curlMetrics('PRIVATE-RPC-KEY', 28),
  });
  expect(JSON.stringify(report)).not.toContain('PRIVATE-RPC-KEY');
  expect(report.curl).toMatchObject({ code: 'curl_metrics_unavailable' });
});
it('records JSON shape without copying provider contents', async () => {
  const report = await compareGateway('https://oracle.example.com', {
    gateway: async () => ({ oracles: [], secret: 'PRIVATE-RPC-KEY' }), curl: async () => curlMetrics('200 0 0 0 0 0 1.1', 0),
  });
  expect(report.node).toMatchObject({ ok: true, hasOraclesArray: true });
  expect(JSON.stringify(report)).not.toContain('PRIVATE-RPC-KEY');
});
it('curl uses TLS verification, no redirect or proxy, checked DNS pinning, and no raw body output', () => {
  const url = 'https://oracle.example.com/prefix/gateway/api/v1/healthy_oracles';
  const args = curlArgs(url, '8.8.8.8');
  expect(args[0]).toBe('-q'); expect(args.at(-1)).toBe(url);
  expect(args).toContain('oracle.example.com:443:8.8.8.8');
  expect(args).toContain('--max-filesize'); expect(args).not.toContain('-k'); expect(args).not.toContain('-L');
  expect(args.slice(args.indexOf('--noproxy'), args.indexOf('--noproxy') + 2)).toEqual(['--noproxy', '*']);
  expect(() => curlArgs(url, '127.0.0.1')).toThrow('unsafe_gateway');
});
it('refuses unsafe bases before invoking either transport', async () => {
  const gateway = vi.fn(), curl = vi.fn();
  await expect(compareGateway('https://user:secret@oracle.example.com', { gateway, curl })).rejects.toThrow('unsafe_gateway');
  expect(gateway).not.toHaveBeenCalled(); expect(curl).not.toHaveBeenCalled();
});

it('curl reports API JSON shape, not response prose, and preserves HTTP version for comparison', () => {
  const payload = '{"oracles":[{}],"secret":"PRIVATE"}';
  const result = curlReport(payload + '\n__GC_CURL_METRICS__200 0 0.05 0.10 0.15 0.2 2', 0);
  expect(result).toMatchObject({ httpStatus: 200, httpVersion: '2', bodyJson: true, hasOraclesArray: true, oracleCount: 1 });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(curlReport('<html>PRIVATE</html>\n__GC_CURL_METRICS__200 0 0 0 0 0 1.1', 0)).toMatchObject({ bodyJson: false, hasOraclesArray: false });
  expect(JSON.stringify(curlReport('PRIVATE', null))).not.toContain('PRIVATE');
});
