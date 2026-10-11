// Opt-in READ-ONLY comparison of the exact health URL: production Node transport vs curl.
// No wallets, signatures, transactions, redirects, raw provider errors or RPC URL output.
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatewayBaseUrl, publicAddress, readGateway, SwitchboardError, type GatewayRead, type GatewayTrace } from '../backend/src/switchboard-gateway.ts';

export function curlMetrics(stdout: string, exitCode: number | null) {
  const parts = stdout.trim().split(/\s+/);
  const valid = parts.length === 7 && /^\d{3}$/.test(parts[0]) && parts.slice(1, 6).every(p => /^\d+(?:\.\d+)?$/.test(p)) && /^(?:0|1\.[01]|2|3)$/.test(parts[6]);
  return valid ? { exitCode, httpStatus: Number(parts[0]), dnsMs: Math.round(Number(parts[1]) * 1000),
    tcpMs: Math.round(Number(parts[2]) * 1000), tlsMs: Math.round(Number(parts[3]) * 1000),
    firstByteMs: Math.round(Number(parts[4]) * 1000), totalMs: Math.round(Number(parts[5]) * 1000), httpVersion: parts[6] }
    : { exitCode, code: 'curl_metrics_unavailable' };
}
export function curlArgs(url: string, address: string): string[] {
  if (!publicAddress(address) || address.includes(':')) throw new SwitchboardError('unsafe_gateway');
  return ['-q', '-4', '--noproxy', '*', '--proto', '=https', '--connect-timeout', '5', '--max-time', '12',
    '--silent', '--resolve', `${new URL(url).hostname}:443:${address}`, '--max-filesize', '262144', '--output', '-', '--header', 'accept: application/json', '--header', 'content-type: application/json',
    '--write-out', '\n__GC_CURL_METRICS__%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_version}', url];
}
export function curlReport(stdout: string, exitCode: number | null) {
  const marker = '\n__GC_CURL_METRICS__';
  const split = stdout.lastIndexOf(marker);
  const metrics = curlMetrics(split < 0 ? '' : stdout.slice(split + marker.length), exitCode);
  let bodyJson = false, hasOraclesArray = false, oracleCount: number | null = null;
  if (split >= 0 && split <= 262144) {
    try {
      const raw = JSON.parse(stdout.slice(0, split)); bodyJson = true;
      hasOraclesArray = Array.isArray(raw?.oracles);
      if (hasOraclesArray) oracleCount = raw.oracles.length;
    } catch { /* Never emit provider response text. */ }
  }
  return { ...metrics, bodyJson, hasOraclesArray, oracleCount };
}
type CurlResult = ReturnType<typeof curlMetrics> & { resolveMs?: number; bodyJson?: boolean; hasOraclesArray?: boolean; oracleCount?: number | null };
async function runCurl(url: string): Promise<CurlResult> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: LookupAddress[];
  try {
    addresses = await Promise.race([
      lookup(new URL(url).hostname, { family: 4, all: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SwitchboardError('curl_dns_timeout')), 5000); }),
    ]);
  } catch (error) {
    return { exitCode: null, code: error instanceof SwitchboardError ? error.code : 'curl_dns_unavailable' };
  } finally { clearTimeout(timer); }
  const resolveMs = Math.round(performance.now() - started);
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return { exitCode: null, code: 'unsafe_gateway', resolveMs };
  return new Promise(resolve => {
    // Pin DNS just as the relay does. No shell, curlrc, proxy credentials, -k or -L.
    execFile('curl', curlArgs(url, addresses[0].address), { timeout: 15_000, maxBuffer: 270336 }, (error, stdout) => {
      resolve({ ...curlReport(stdout ?? '', error ? typeof error.code === 'number' ? error.code : null : 0), resolveMs });
    });
  });
}
export async function compareGateway(uri: string, deps: { gateway?: GatewayRead; curl?: typeof runCurl } = {}) {
  const base = gatewayBaseUrl(uri);
  const url = new URL(`${base}/gateway/api/v1/healthy_oracles`);
  const stages: Parameters<GatewayTrace>[0][] = [];
  const start = performance.now();
  const node = (deps.gateway ?? readGateway)(base, 'healthy_oracles', undefined, event => stages.push(event))
    .then(raw => ({ ok: true, hasOraclesArray: Array.isArray((raw as { oracles?: unknown } | null)?.oracles) }),
      error => ({ ok: false, code: error instanceof SwitchboardError ? error.code : 'node_request_failed' }))
    .then(result => ({ ...result, totalMs: Math.round(performance.now() - start), stages }));
  const [nodeResult, curlResult] = await Promise.all([node, (deps.curl ?? runCurl)(url.href)]);
  // This is the PUBLIC on-chain oracle route, never the application's keyed RPC URL.
  return { origin: url.origin, requestPath: url.pathname, node: nodeResult, curl: curlResult };
}
async function main() {
  process.loadEnvFile(fileURLToPath(new URL('../backend/.env', import.meta.url)));
  // Configuration imports MUST follow loadEnvFile. No ingest/DB/crank startup here.
  const { Connection } = await import('@solana/web3.js');
  const { RPC_URL } = await import('../backend/src/config.ts');
  const { loadQueue, switchboardConnection } = await import('../backend/src/switchboard.ts');
  const snapshot = await loadQueue(switchboardConnection(new Connection(RPC_URL)));
  const candidates = snapshot.candidates.filter(c => c.eligible);
  const bases = [...new Set(candidates.map(c => c.gateway))].slice(0, 2);
  const probes = [];
  for (const base of bases) probes.push(await compareGateway(base));
  console.log(JSON.stringify({ version: 1, readOnly: true, genesis: snapshot.genesis, eligibleMembers: candidates.length,
    note: 'Same health URL; Node deadline 8s, curl 12s, curl pinned public IPv4 (resolveMs is the separate DNS read). User agents and connection implementations differ.', probes }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ readOnly: true, code: error instanceof SwitchboardError ? error.code : 'doctor_setup_failed' }));
    process.exitCode = 1;
  });
}
