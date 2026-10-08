// Server-only transport. No caller-supplied URL, redirects, private-network access,
// or RPC credentials are allowed through the public Switchboard relay.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class SwitchboardError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(ip, bits, 'ipv6');
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? !blocked.check(ip, 'ipv4') : family === 6 && globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}
export function gatewayOrigin(uri: string): string {
  let url: URL;
  try { url = new URL(uri); } catch { throw new SwitchboardError('unsafe_gateway'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/' || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')) {
    throw new SwitchboardError('unsafe_gateway');
  }
  return url.origin;
}
export type GatewayRead = (origin: string, operation: 'healthy_oracles' | 'randomness_reveal', body?: unknown) => Promise<unknown>;

export const readGateway: GatewayRead = async (origin, operation, body) => {
  const url = new URL(`/gateway/api/v1/${operation}`, gatewayOrigin(origin));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      // Pin the socket to the checked DNS result. A second resolution after validation
      // would permit DNS rebinding. TLS still verifies the original hostname.
      ...{ autoSelectFamily: false },
      lookup: (hostname, _options, callback) => {
        void lookup(hostname, { all: true }).then(records => {
          if (!records.length || records.some(r => !publicAddress(r.address))) {
            callback(new SwitchboardError('unsafe_gateway'), '', 4); return;
          }
          const r = records.find(r => r.family === 4) ?? records[0];
          callback(null, r.address, r.family);
        }, () => callback(new SwitchboardError('gateway_dns'), '', 4));
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.destroy(); reject(new SwitchboardError(`gateway_http_${res.statusCode ?? 0}`)); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) req.destroy(new SwitchboardError('gateway_payload_too_large'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new SwitchboardError('gateway_network')));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new SwitchboardError('gateway_schema')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new SwitchboardError('gateway_timeout')), 8000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', e => reject(e instanceof SwitchboardError ? e : new SwitchboardError('gateway_network')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
};

export function revealPayload(raw: unknown) {
  const j = raw as { signature?: unknown; recovery_id?: unknown; value?: unknown } | null;
  if (!j || typeof j.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(j.signature) ||
      Buffer.from(j.signature, 'base64').length !== 64 ||
      !Number.isInteger(j.recovery_id) || (j.recovery_id as number) < 0 || (j.recovery_id as number) > 3 ||
      !Array.isArray(j.value) || j.value.length !== 32 || j.value.some(x => !Number.isInteger(x) || x < 0 || x > 255)) {
    throw new SwitchboardError('gateway_schema');
  }
  return { signature: j.signature, recovery_id: j.recovery_id as number, value: j.value as number[] };
}
