import { describe, expect, it } from 'vitest';
import { rpcEndpoints } from './rpcEndpoints';

describe('RPC endpoint selection', () => {
  const original = { rpc: 'https://original.invalid', das: undefined, ws: 'wss://original.invalid/socket' };
  it('defaults DAS to the currently selected HTTP RPC', () => {
    expect(rpcEndpoints('https://new.invalid', original)).toEqual({ rpc: 'https://new.invalid', das: 'https://new.invalid', ws: undefined });
  });
  it('retains a deliberately configured DAS service', () => {
    expect(rpcEndpoints('https://new.invalid', { ...original, das: 'https://indexer.invalid' }).das).toBe('https://indexer.invalid');
  });
  it('keeps the configured WS only while HTTP still uses its configured endpoint', () => {
    expect(rpcEndpoints(undefined, original).ws).toBe(original.ws);
    expect(rpcEndpoints(original.rpc, original).ws).toBe(original.ws);
  });
  it('does not treat a websocket or malformed override as HTTP RPC', () => {
    for (const override of ['wss://new.invalid', '', 'not-a-url']) expect(rpcEndpoints(override, original).rpc).toBe(original.rpc);
  });
});
