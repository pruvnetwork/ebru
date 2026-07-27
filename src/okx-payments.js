/**
 * Official OKX Payment SDK integration.
 *
 * The marketplace rejected our hand-written x402 with: "your service is not
 * integrated with the official OKX Payment SDK, which prevents us from
 * completing verification." Our implementation was protocol-correct — the
 * challenge validated, the network and EIP-3009 domain were right — but
 * verification happens on OKX's side against their broker, and that only works
 * when the seller runs their middleware. So the gate is the SDK itself, not the
 * shape of the response.
 *
 * This wraps the SDK so the rest of the service does not have to know about it:
 * `paymentGate()` returns an Express middleware when credentials are present,
 * and null when they are not. Missing credentials must never take the service
 * down — an unpaid but working endpoint beats a broken one.
 */

import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@okxweb3/x402-express';

/** X Layer mainnet, in the CAIP-2 form the marketplace asked for. */
export const NETWORK = 'eip155:196';

export function okxCredentials(env = process.env) {
  const apiKey = env.OKX_API_KEY;
  const secretKey = env.OKX_SECRET_KEY;
  const passphrase = env.OKX_PASSPHRASE;
  const payTo = env.EBRU_X402_PAY_TO;
  return {
    apiKey,
    secretKey,
    passphrase,
    payTo,
    /** Price as a USD string; the SDK converts to the settlement stablecoin. */
    price: env.EBRU_X402_USD_PRICE ?? '$0.001',
    ready: Boolean(apiKey && secretKey && passphrase && payTo),
  };
}

/**
 * Build the payment middleware, or return null if it cannot be configured.
 *
 * @param {string[]} paths route patterns to protect, e.g. ['POST /mcp']
 */
export function paymentGate(paths = ['POST /mcp'], env = process.env) {
  const creds = okxCredentials(env);
  if (!creds.ready) return null;

  const facilitator = new OKXFacilitatorClient({
    apiKey: creds.apiKey,
    secretKey: creds.secretKey,
    passphrase: creds.passphrase,
  });

  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(NETWORK, new ExactEvmScheme());

  const routes = {};
  for (const path of paths) {
    routes[path] = {
      accepts: [
        {
          scheme: 'exact',
          network: NETWORK,
          payTo: creds.payTo,
          price: creds.price,
        },
      ],
      description:
        'Ebru — Turkish paper marbling, computed. MCP tools: marble, wallet_portrait.',
      mimeType: 'application/json',
    };
  }

  return paymentMiddleware(routes, resourceServer);
}
