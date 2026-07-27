/**
 * The one place the engine talks to a chain.
 *
 * Only `/portrait` uses this, and only to pin a reading to a block height —
 * `/marble` stays completely offline, which is what lets it be free and
 * unbreakable. Everything here fails soft: a portrait rendered without a block
 * is worse (it is not reproducible) but it is still a portrait, and an ASP that
 * returns nothing when someone else's RPC is down is worse than both.
 */

const CHAINS = {
  xlayer: {
    label: 'X Layer',
    chainId: 196,
    rpc: process.env.EBRU_XLAYER_RPC ?? 'https://xlayerrpc.okx.com',
  },
};

export const CHAIN_NAMES = Object.keys(CHAINS);

export function chainInfo(name) {
  return CHAINS[name] ?? null;
}

/**
 * Latest block height, or null if the chain cannot be reached in time.
 *
 * @param {string} chain
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] give up rather than hold a request open
 * @returns {Promise<number|null>}
 */
export async function latestBlock(chain = 'xlayer', { timeoutMs = 2500 } = {}) {
  const info = CHAINS[chain];
  if (!info) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(info.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = await res.json();
    if (typeof body?.result !== 'string') return null;

    const height = Number.parseInt(body.result, 16);
    return Number.isFinite(height) && height > 0 ? height : null;
  } catch {
    // Timeout, DNS, malformed response — all the same to a caller who just
    // wants a picture.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
