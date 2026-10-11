#!/usr/bin/env python3
"""Read-only, fixed public HTTP controls. No application imports, RPC, keys or transactions.

These two on-chain /devnet gateway bases were observed on the Mac on 2026-10-09.
This measures API transport from a second network, NOT current queue eligibility or reveal.
Bodies, raw errors and headers are never printed. Run with --github-annotations in CI.
"""
import concurrent.futures
import ipaddress
import json
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

LIMIT = 262144
FIRST = 'https://141.95.35.110.xip.switchboard-oracles.xyz'
SECOND = 'https://141.95.98.113.xip.switchboard-oracles.xyz'
HEALTH = '/devnet/gateway/api/v1/healthy_oracles'
TARGETS = (
    ('registry', 'https://crossbar.switchboard.xyz/gateways?network=devnet', False),
    ('root_control', FIRST + '/', False),
    ('test_control', FIRST + '/devnet/gateway/api/v1/test', False),
    ('health_first', FIRST + HEALTH, False),
    ('health_second', SECOND + HEALTH, False),
    ('health_first_compressed', FIRST + HEALTH, True),
)


def public_ipv4(address):
    ip = ipaddress.ip_address(address)
    return (ip.version == 4 and ip.is_global and not ip.is_multicast
            and not ip.is_reserved and not ip.is_loopback and not ip.is_link_local
            and ip not in ipaddress.ip_network('192.0.0.0/24'))


def curl_args(url, address, output, compressed=False):
    # Fixed targets only, including at this low-level boundary. Never an arbitrary proxy.
    if url not in {target[1] for target in TARGETS} or not public_ipv4(address):
        raise ValueError('unsafe_target')
    args = ['curl', '-q', '-4', '--noproxy', '*', '--proto', '=https',
            '--connect-timeout', '5', '--max-time', '12', '--max-filesize', str(LIMIT),
            '--silent', '--resolve', f'{urlsplit(url).hostname}:443:{address}',
            '--header', 'accept: application/json', '--header', 'content-type: application/json',
            '--output', str(output), '--write-out', '%{json}']
    if compressed:
        args.append('--compressed')
    return args + [url]


def summarize(stdout, body, exit_code):
    try:
        metrics = json.loads(stdout)
    except (ValueError, UnicodeError):
        metrics = {}
    if not isinstance(metrics, dict):
        metrics = {}
    result = {'exitCode': exit_code, 'bodyBytes': len(body), 'bodyJson': False,
              'hasOraclesArray': False, 'oracleCount': None}
    for source, target in [('http_code', 'httpStatus'), ('time_connect', 'tcpSeconds'),
                           ('time_appconnect', 'tlsSeconds'), ('time_starttransfer', 'firstByteSeconds'),
                           ('time_total', 'totalSeconds'), ('size_download', 'wireBytes')]:
        value = metrics.get(source)
        if type(value) in (int, float) and 0 <= value < 1e12:
            result[target] = value
    version = metrics.get('http_version')
    if version in ('0', '1.0', '1.1', '2', '3'):
        result['httpVersion'] = version
    mime = str(metrics.get('content_type', '')).split(';')[0].strip().lower()
    result['contentType'] = mime if mime in ('application/json', 'text/html', 'text/plain', 'text/event-stream') else 'other'
    if len(body) <= LIMIT:
        try:
            value = json.loads(body)
            result['bodyJson'] = True
            if isinstance(value, dict) and isinstance(value.get('oracles'), list):
                result['hasOraclesArray'] = True
                result['oracleCount'] = len(value['oracles'])
            if isinstance(value, list):
                result['arrayCount'] = len(value)
        except (ValueError, UnicodeError, RecursionError):
            pass
    result['completeHealthResponse'] = (exit_code == 0 and result.get('httpStatus') == 200
                                        and result['hasOraclesArray'])
    return result


def probe(target):
    name, url, compressed = target
    result = {'name': name, 'url': url, 'compressedRequested': compressed}
    try:
        # Validate and pin public IPv4, preserving the original TLS hostname. Never redirect.
        records = socket.getaddrinfo(urlsplit(url).hostname, 443, socket.AF_INET, socket.SOCK_STREAM)
        addresses = sorted({r[4][0] for r in records})
        if not addresses or not all(public_ipv4(address) for address in addresses):
            return {**result, 'code': 'unsafe_dns'}
        with tempfile.TemporaryDirectory(prefix='sb-network-') as folder:
            output = Path(folder) / 'body'
            run = subprocess.run(curl_args(url, addresses[0], output, compressed),
                                 capture_output=True, timeout=17, check=False)
            body = b''
            if output.exists():
                with output.open('rb') as stream:
                    body = stream.read(LIMIT + 1)
            return {**result, **summarize(run.stdout, body, run.returncode)}
    except socket.gaierror:
        return {**result, 'code': 'dns_unavailable'}
    except subprocess.TimeoutExpired:
        return {**result, 'code': 'process_timeout'}
    except (OSError, ValueError):
        return {**result, 'code': 'probe_failed'}


def annotation(result):
    message = json.dumps(result, separators=(',', ':')).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    return '::notice title=Switchboard public HTTP probe::' + message


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(probe, TARGETS))
    print(json.dumps({'readOnly': True, 'note': 'Transport control only; no chain eligibility, reveal or settlement proof.',
                      'probes': results}, indent=2))
    if '--github-annotations' in sys.argv[1:]:
        for result in results:
            print(annotation(result))
    # Successful job means a complete health response was observed, not that a wager is safe.
    return 0 if any(r.get('completeHealthResponse') for r in results) else 1


if __name__ == '__main__':
    sys.exit(main())
