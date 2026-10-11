import { DAS_RPC_OVERRIDE, RPC_URL, RPC_WS_URL } from './config';

/** Keep HTTP/DAS/WS coherent when the profile changes the RPC at runtime.
 * A separately configured DAS endpoint remains authoritative. An old explicit WS
 * endpoint must not follow a different HTTP RPC (web3 derives the new WS URL). */
export function rpcEndpoints(override?: string, configured = { rpc: RPC_URL, das: DAS_RPC_OVERRIDE, ws: RPC_WS_URL }) {
  const rpc = override && /^https?:\/\//.test(override) ? override : configured.rpc;
  return { rpc, das: configured.das ?? rpc, ws: rpc === configured.rpc ? configured.ws : undefined };
}
