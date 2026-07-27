/**
 * Serverless entry point.
 *
 * Two layers. The official OKX payment middleware owns the 402 handshake;
 * everything it lets through — and every other path — falls to the same handler
 * that backs the local server, so there is still exactly one implementation of
 * the service itself.
 *
 * Express exists here only because the SDK ships as Express middleware. If the
 * OKX credentials are absent the middleware is skipped entirely and the service
 * behaves exactly as it did before, which keeps a missing secret from taking the
 * endpoint down.
 */

import express from 'express';
import { ebruHandler } from '../src/service.js';
import { paymentGate } from '../src/okx-payments.js';

const app = express();

// Trust the platform proxy so the SDK and our own code see the real scheme,
// host and client address rather than the internal ones.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Buffer the body once, here, and hand the same buffer to everything below.
// The payment decision needs to read the JSON-RPC method before it can be made,
// and `express.json()` would consume the stream and leave the handler with an
// empty request. The cap is deliberately above the handler's own 2 MB limit so
// that an oversized body is still refused by us, with our own 413, rather than
// by the parser with a different shape of error.
app.use(express.raw({ type: '*/*', limit: '4mb' }));

const gate = paymentGate(['POST /mcp', 'GET /mcp']);

/** The JSON-RPC method in an already-buffered body, or null if there isn't one. */
function rpcMethod(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return null;
  let msg;
  try {
    msg = JSON.parse(req.body.toString('utf8'));
  } catch {
    return null;
  }
  // A batch is chargeable if any message in it is.
  const list = Array.isArray(msg) ? msg : [msg];
  const call = list.find((m) => m && typeof m === 'object' && m.method === 'tools/call');
  if (call) return 'tools/call';
  const first = list.find((m) => m && typeof m === 'object' && typeof m.method === 'string');
  return first ? first.method : null;
}

if (gate) {
  // Charge at the tool/call stage and nowhere else.
  //
  // MCP puts initialize, tools/list and tools/call behind a single route, so
  // mounting the SDK middleware on the route — which is how this was wired
  // before — inevitably prices the handshake too. That is the exact wording of
  // the last listing rejection: charges initiated outside the tool/call stage.
  // Routing on the method instead keeps discovery free and charges only for
  // the work.
  app.use((req, res, next) => {
    if (req.path !== '/mcp') return next();
    if (rpcMethod(req) !== 'tools/call') return next();
    return gate(req, res, next);
  });
} else {
  console.warn('[ebru] OKX payment credentials absent — serving without the payment gate.');
}

// Everything else, including the MCP handler itself once payment is settled.
app.use((req, res) => ebruHandler(req, res));

export default app;
