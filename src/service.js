/**
 * The ASP surface.
 *
 * Two services on one listing:
 *
 *   GET /marble    free, no network, returns the artwork directly
 *   GET /portrait  paid, reads a wallet as a bath
 *
 * A2MCP requires a paid endpoint to speak x402 and a free endpoint to simply
 * return the result. `/marble` is deliberately the latter and deliberately
 * touches nothing external: it cannot fail on someone else's outage, which is
 * the whole reason it can carry volume.
 *
 * Zero dependencies beyond the rasteriser — no framework, so there is nothing
 * between a request and the bath.
 */

import { createServer } from 'node:http';
import { render, renderReading } from './index.js';
import { toPng } from './raster.js';
import { PATTERN_NAMES, PALETTE_NAMES } from './index.js';
import { latestBlock } from './chain.js';
import { handleRpc, unrecognizedPost } from './mcp.js';
import { paymentConfig, paymentRequirements, challengeBody, decodePayment, verifyPayment, settlePayment, settlementHeader, MCP_RESOURCE_DESCRIPTION } from './x402.js';

const MAX_SIZE = 2000;
// Delivery size only — the bath is always marbled at the same resolution, so
// this trades payload and rasterising time, never the artwork itself. 600px is
// enough for an avatar or a cover; callers who want a print ask for one.
const DEFAULT_SIZE = 600;

/**
 * Repeated calls are common — agents retry, and a popular seed gets asked for
 * again. Rendering is pure, so caching is free correctness-wise.
 */
class Cache {
  constructor(limit = 240) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

/**
 * Per-caller limit on *renders*, not on requests.
 *
 * The scarce resource here is a second or two of CPU spent marbling; serving an
 * already-rendered sheet from the cache costs nothing worth metering. So a
 * caller can pull the same artwork as often as it likes and only pays budget
 * when it asks for paint that does not exist yet. That happens to reward
 * exactly the behaviour we want from agents — reuse a seed rather than churn
 * through new ones.
 */
class RenderLimiter {
  constructor({ limit = 20, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  take(key, now) {
    const cutoff = now - this.windowMs;
    let times = this.hits.get(key);
    if (!times) {
      times = [];
      this.hits.set(key, times);
    }
    // Drop anything that has aged out of the window.
    while (times.length && times[0] <= cutoff) times.shift();

    if (times.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
      return { ok: false, remaining: 0, retryAfter };
    }

    times.push(now);
    return { ok: true, remaining: this.limit - times.length, retryAfter: 0 };
  }

  /** Keep the map from growing without bound on a long-lived instance. */
  prune(now) {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      while (times.length && times[0] <= cutoff) times.shift();
      if (!times.length) this.hits.delete(key);
    }
  }
}

/**
 * All mutable state lives in a context rather than in module scope, so two
 * services in one process — the real one and a test one, say — cannot spend
 * each other's budget or read each other's cache.
 *
 * `maxInFlight` is a ceiling on renders happening at once. The per-caller limit
 * does not help when the callers are many and each asks once; without this a
 * burst simply queues up inside the event loop until everything times out
 * together.
 */
function makeContext({
  rendersPerMinute = Number(process.env.EBRU_RENDERS_PER_MIN ?? 20),
  maxInFlight = Number(process.env.EBRU_MAX_IN_FLIGHT ?? 4),
  cacheSize = 240,
  payments,
} = {}) {
  return {
    cache: new Cache(cacheSize),
    limiter: new RenderLimiter({ limit: rendersPerMinute, windowMs: 60_000 }),
    maxInFlight,
    inFlight: 0,
    sweptAt: 0,
    payments: payments ?? paymentConfig(),
  };
}

/**
 * The origin as the outside world sees it.
 *
 * Behind Vercel's proxy TLS is terminated upstream, so the request arrives as
 * plain http and `url.origin` would advertise an http:// address for a service
 * whose listing requires https. Trust the forwarded scheme.
 */
function publicOrigin(req, url) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? url.host);
  return `${proto || url.protocol.replace(':', '')}://${host}`;
}

function clientKey(req) {
  // Vercel and most proxies put the real caller first in x-forwarded-for.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Reserve capacity to render. Throws an HttpError the caller can act on rather
 * than a generic failure — an agent that gets 429 with Retry-After can behave.
 */
function reserveRender(req, ctx) {
  const now = Date.now();

  if (now - ctx.sweptAt > 60_000) {
    ctx.limiter.prune(now);
    ctx.sweptAt = now;
  }

  if (ctx.inFlight >= ctx.maxInFlight) {
    throw new HttpError(503, 'Too many sheets in the bath right now. Retry in a moment.', { 'retry-after': '2' });
  }

  const verdict = ctx.limiter.take(clientKey(req), now);
  if (!verdict.ok) {
    throw new HttpError(
      429,
      `Render limit is ${ctx.limiter.limit} new artworks per minute. Repeating a seed you have already asked for is free and unlimited.`,
      { 'retry-after': String(verdict.retryAfter) },
    );
  }
  return { ...verdict, limit: ctx.limiter.limit };
}

function clampSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(120, Math.min(MAX_SIZE, Math.round(n)));
}

/** One place to decide what a request actually asked for. */
function readParams(url) {
  const q = url.searchParams;
  const size = clampSize(q.get('size'));
  const format = (q.get('format') ?? 'png').toLowerCase();

  const pattern = q.get('pattern') ?? undefined;
  if (pattern && !PATTERN_NAMES.includes(pattern)) {
    throw new HttpError(400, `Unknown pattern "${pattern}". Choose one of: ${PATTERN_NAMES.join(', ')}`);
  }
  const palette = q.get('palette') ?? undefined;
  if (palette && !PALETTE_NAMES.includes(palette)) {
    throw new HttpError(400, `Unknown palette "${palette}". Choose one of: ${PALETTE_NAMES.join(', ')}`);
  }
  if (!['png', 'svg', 'json'].includes(format)) {
    throw new HttpError(400, `Unknown format "${format}". Choose png, svg or json.`);
  }

  return { size, format, pattern, palette };
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Turn a render result into the bytes the caller asked for.
 *
 * Returns the finished body rather than writing it, because rasterising is the
 * expensive half of a request — several times the cost of the marbling itself —
 * and it is what the cache needs to hold. Caching the SVG alone would re-encode
 * a PNG on every hit and save almost nothing.
 */
function encode({ svg, meta, legend }, format, size) {
  if (format === 'svg') {
    return { body: svg, type: 'image/svg+xml; charset=utf-8', meta };
  }
  if (format === 'png') {
    return { body: toPng(svg, { width: size }), type: 'image/png', meta };
  }
  const payload = { meta, image: `data:image/png;base64,${toPng(svg, { width: size }).toString('base64')}` };
  if (legend) payload.legend = legend;
  return { body: JSON.stringify(payload), type: 'application/json; charset=utf-8', meta };
}

function send(res, status, type, body, meta, verdict, extra) {
  const headers = {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
  };
  // Only present when this response cost a render — a cache hit is unmetered
  // and says so by omitting these.
  if (verdict) {
    headers['x-ratelimit-limit'] = String(verdict.limit);
    headers['x-ratelimit-remaining'] = String(verdict.remaining);
  }
  // The provenance travels with the image, so a caller that only keeps the PNG
  // can still say what it is and reproduce it.
  if (meta) {
    headers['x-ebru-pattern'] = meta.pattern;
    headers['x-ebru-palette'] = meta.palette;
    if (meta.seed) headers['x-ebru-seed'] = encodeURIComponent(meta.seed);
    if (meta.block) headers['x-ebru-block'] = String(meta.block);
    headers['x-ebru-render-ms'] = String(meta.renderMs);
  }
  res.writeHead(status, { ...headers, ...extra });
  res.end(body);
}

function fail(res, status, message, extra = {}) {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...extra,
  });
  res.end(body);
}

/**
 * What a caller will actually be charged, in one place.
 *
 * There are two gates that can be live — the official SDK's and our own — and
 * only one of them runs at a time. Reading `enabled` alone reports the SDK's
 * price as zero, which is how the manifest came to advertise a free service
 * while the endpoint charged for it.
 */
function advertisedPrice(ctx) {
  if (ctx.payments.sdkActive) return ctx.payments.sdkPrice;
  return ctx.payments.enabled ? ctx.payments.display : '0';
}

/** X Layer mainnet, in the CAIP-2 form both the marketplace and the SDK use. */
const SETTLEMENT_NETWORK = 'eip155:196';

/** The SDK's own timeout on a challenge, restated so the manifest can quote it. */
const SDK_TIMEOUT_SECONDS = 300;

/**
 * A USD price string in atomic units of the settlement asset.
 *
 * Done on the decimal string rather than through a float on purpose: $0.001 has
 * no exact binary form, and multiplying it out lands just past 1000 rather than
 * on it. Returns null if the price carries more precision than the asset has,
 * because rounding someone's price silently is worse than omitting the entry.
 */
function atomicAmount(price, decimals) {
  const digits = String(price).replace(/[^\d.]/g, '');
  if (!/^\d*\.?\d*$/.test(digits) || digits === '' || digits === '.') return null;
  const [whole = '', fraction = ''] = digits.split('.');
  if (fraction.length > decimals) return null;
  const atomic = `${whole || '0'}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return atomic;
}

/**
 * The payment the endpoint's own 402 asks for, restated in the manifest.
 *
 * This was an empty list, and an empty list is a worse answer than no list at
 * all: the manifest named a price but never said in what, to whom, or on which
 * network, so a caller that builds its payment from the manifest — rather than
 * by provoking a challenge first — had nothing it could sign. Both gates
 * therefore report through the same functions that generate their challenges,
 * so the two cannot drift apart.
 *
 * When the SDK gate is live the amount comes from the USD price the SDK is
 * configured with, never from `EBRU_X402_PRICE`: that variable drives our own
 * gate only, and reading it while the SDK is the one answering is exactly how
 * the manifest would come to quote an amount the challenge does not ask for.
 */
function manifestAccepts(ctx, resource) {
  const p = ctx.payments;

  if (p.enabled) {
    const req = paymentRequirements(p, { resource, description: MCP_RESOURCE_DESCRIPTION });
    return [{
      scheme: req.scheme,
      network: req.network,
      amount: req.maxAmountRequired,
      asset: req.asset,
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    }];
  }

  if (!p.sdkActive) return [];
  const amount = atomicAmount(p.sdkPrice, p.decimals);
  // No receiving address, no asset, or an unrepresentable price means there is
  // nothing a caller could actually sign. Say nothing rather than something
  // half-formed — the challenge is still there to be asked for.
  if (!amount || amount === '0' || !p.payTo || !p.asset) return [];
  return [{
    scheme: 'exact',
    network: SETTLEMENT_NETWORK,
    amount,
    asset: p.asset,
    payTo: p.payTo,
    maxTimeoutSeconds: SDK_TIMEOUT_SECONDS,
    extra: { name: p.tokenName, version: p.tokenVersion },
  }];
}

function manifest(ctx) {
  return {
  name: 'Ebru',
  summary: 'Turkish paper marbling, computed. A seed goes in, a marbled sheet comes out — deterministic, sub-second, no model.',
  services: [
    {
      path: '/marble',
      price: '0',
      summary: 'Any string becomes an original marbled artwork. Instant, never fails, safe to call in a loop.',
      params: {
        seed: 'required — any string: a phrase, an address, a hash, an agent name',
        size: `optional — pixels, ${120}-${MAX_SIZE}, default ${DEFAULT_SIZE}`,
        pattern: `optional — ${PATTERN_NAMES.join(' | ')}`,
        palette: `optional — ${PALETTE_NAMES.join(' | ')}`,
        format: 'optional — png | svg | json, default png',
      },
    },
    {
      path: '/portrait',
      // The SDK gate guards /mcp and nothing else, so this REST surface is
      // priced by our own gate or it is free. Quoting the MCP price here would
      // make the manifest advertise a charge that never arrives — the same
      // class of mismatch that had it advertising free while /mcp charged.
      price: ctx.payments.enabled ? ctx.payments.display : '0',
      payment: ctx.payments.enabled
        ? { protocol: 'x402', network: ctx.payments.network, asset: ctx.payments.asset }
        : 'free — the paid surface is the MCP endpoint at /mcp',
      summary: 'Reads a wallet as a bath: every transaction is a drop, oldest deepest. Returns the artwork plus a legend naming each mark.',
      params: {
        address: 'required',
        block: 'recommended — pins the reading so the artwork is reproducible forever',
        events: 'optional — supply the history yourself (JSON POST) and no chain lookup happens',
        format: 'optional — png | svg | json, default json (the legend is the point)',
      },
    },
    ],
  };
}

/** Read and parse a JSON body, with a hard cap so a bad caller cannot exhaust us. */
async function readJson(req, limit = 2_000_000) {
  // The serverless front end buffers the body before we see it (api/index.js
  // has to, in order to route on the JSON-RPC method), which leaves the stream
  // empty. When that has happened the buffer is the only copy of the body.
  const buffered = req.body;
  if (Buffer.isBuffer(buffered)) {
    if (buffered.length > limit) throw new HttpError(413, 'Body too large.');
    if (!buffered.length) return {};
    try {
      return JSON.parse(buffered.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Body is not valid JSON.');
    }
  }
  // Already parsed by something upstream — take it as-is.
  if (buffered && typeof buffered === 'object') return buffered;

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'Body too large.');
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
}

/**
 * The request handler on its own, so it can be mounted either on a plain
 * node server or on a serverless platform that hands us (req, res) directly.
 */
async function handle(req, res, ctx) {
  // Keep `res.statusCode` in step with whatever we write.
  //
  // This matters for money. The payment middleware buffers our response and
  // then decides whether to take payment by reading `res.statusCode` — it
  // settles unless the status is 4xx or 5xx. But it buffers by replacing
  // `res.writeHead`, and a replaced `writeHead` never touches `statusCode`.
  // We set status *only* through `writeHead`, so as far as the middleware can
  // see every response we make is a 200, and a caller who paid and then got an
  // error would be charged for it anyway. Setting both keeps the refusal path
  // honest, and costs nothing when no middleware is in front of us.
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    if (typeof status === 'number') res.statusCode = status;
    return writeHead(status, ...rest);
  };

  {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return fail(res, 400, 'Unparseable URL.');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    try {
      // Probes often HEAD a URL first. Treat it as GET and drop the body.
      const isHead = req.method === 'HEAD';
      if (isHead) req.method = 'GET';

      if (url.pathname === '/' || url.pathname === '/manifest') {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(manifest(ctx), null, 2));
      }

      // Discovery. Crawlers and the marketplace's own probes look for a service
      // manifest under /.well-known before they try anything else; answering
      // 404 there makes a live service look absent. Both spellings we have seen
      // requested are served the same document.
      if (url.pathname === '/.well-known/x402' || url.pathname === '/.well-known/a2mcp.json') {
        const origin = publicOrigin(req, url);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
          x402Version: 2,
          name: 'Ebru',
          tagline: 'Turkish paper marbling, computed.',
          description:
            'A 500-year-old Ottoman marbling craft, computed rather than generated. Send any string and get an original marbled artwork; point it at a wallet and every transaction becomes a drop of paint. The same seed always returns the same artwork.',
          category: 'Art creation',
          protocol: 'mcp',
          transport: 'streamable-http',
          endpoint: `${origin}/mcp`,
          price: advertisedPrice(ctx),
          payment: {
            protocol: 'x402',
            network: 'eip155:196',
            // State the staging explicitly. A caller — and a reviewer — should
            // be able to read here that the handshake is free before finding out
            // by trying it.
            chargedAt: 'tools/call',
            free: ['initialize', 'ping', 'tools/list', 'resources/list', 'prompts/list'],
          },
          accepts: manifestAccepts(ctx, `${origin}/mcp`),
          services: [
            {
              name: 'marble',
              price: advertisedPrice(ctx),
              endpoint: `${origin}/mcp`,
              description: 'Any string becomes an original marbled artwork. Deterministic: the same seed always returns the same sheet.',
              input: { seed: 'required, any string', size: 'optional 120-2000', pattern: 'optional', palette: 'optional' },
            },
            {
              name: 'wallet_portrait',
              price: advertisedPrice(ctx),
              endpoint: `${origin}/mcp`,
              description: 'Reads a wallet as a marbling bath — every transaction is a drop of paint, oldest laid first. Returns the artwork plus a legend.',
              input: { address: 'required', block: 'optional X Layer height', events: 'optional history' },
            },
          ],
        }, null, 2));
      }

      if (url.pathname === '/health') {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      }

      if (url.pathname === '/marble') {
        const seed = url.searchParams.get('seed');
        if (!seed) throw new HttpError(400, 'Pass ?seed= — any string will do.');

        const { size, format, pattern, palette } = readParams(url);
        const key = `m|${seed}|${size}|${format}|${pattern ?? ''}|${palette ?? ''}`;

        // Cache first, and deliberately before the limiter: a hit costs nothing
        // to serve, so it should never be refused.
        const hit = ctx.cache.get(key);
        if (hit) return send(res, 200, hit.type, hit.body, hit.meta);

        const verdict = reserveRender(req, ctx);
        ctx.inFlight++;
        let encoded;
        try {
          encoded = encode(render(seed, { width: 1000, height: 1000, pattern, palette }), format, size);
        } finally {
          ctx.inFlight--;
        }
        ctx.cache.set(key, encoded);
        return send(res, 200, encoded.type, encoded.body, encoded.meta, verdict);
      }

      if (url.pathname === '/portrait') {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const address = url.searchParams.get('address') ?? body.address;
        if (!address) throw new HttpError(400, 'Pass ?address= (or an address in the JSON body).');

        const chain = url.searchParams.get('chain') ?? body.chain ?? 'xlayer';

        const blockRaw = url.searchParams.get('block') ?? body.block;
        let block = blockRaw != null && blockRaw !== '' ? Number(blockRaw) : null;
        if (blockRaw != null && blockRaw !== '' && !Number.isFinite(block)) {
          throw new HttpError(400, 'block must be a number.');
        }

        // Without a height the artwork is not reproducible, so resolve one from
        // the chain rather than rendering something that can never be made
        // again. If the chain cannot be reached we still render — an
        // unreproducible portrait beats no portrait — and say so.
        let pinning = block != null ? 'supplied' : 'resolved';
        if (block == null) {
          block = await latestBlock(chain);
          if (block == null) pinning = 'unavailable';
        }

        const { size, format: rawFormat, pattern, palette } = readParams(url);
        // The legend is the reason this endpoint exists, so JSON is the default.
        const format = url.searchParams.get('format') ? rawFormat : 'json';

        const events = Array.isArray(body.events) ? body.events : null;
        const reading = { address, chain, block, events: events ?? [] };

        // Payment gate. Only reached when a receiving address and a facilitator
        // are both configured; otherwise the service is free and says so.
        let payment = null;
        let requirements = null;
        if (ctx.payments.enabled) {
          const resource = `${url.origin}${url.pathname}`;
          const description = `Ebru portrait of ${address}`;
          requirements = paymentRequirements(ctx.payments, { resource, description });

          payment = decodePayment(req.headers['x-payment']);
          if (!payment) {
            const body = JSON.stringify(challengeBody(ctx.payments, { resource, description }));
            res.writeHead(402, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(body),
              'access-control-allow-origin': '*',
            });
            return res.end(body);
          }

          const check = ctx.payments.settles
            ? await verifyPayment(ctx.payments, payment, requirements)
            : { valid: true };
          if (!check.valid) {
            throw new HttpError(402, `Payment could not be verified: ${check.reason}`);
          }
        }

        const verdict = reserveRender(req, ctx);
        ctx.inFlight++;
        let result;
        try {
          result = renderReading(reading, { width: 1000, height: 1000, pattern, palette });
        } finally {
          ctx.inFlight--;
        }
        result.meta.source = events ? 'caller-supplied' : 'address-only';
        result.meta.pinning = pinning;

        const notes = [];
        if (!events) {
          notes.push(
            'No history was supplied, so this is rendered from the address alone. ' +
            'POST an events array to read the actual account.',
          );
        }
        if (pinning === 'resolved') {
          notes.push(`Pinned to ${chain} block ${block}. Ask for that block again and you get this exact sheet.`);
        } else if (pinning === 'unavailable') {
          notes.push(`${chain} could not be reached, so this sheet is not pinned to a block and cannot be reproduced. Pass ?block= to make it permanent.`);
        }
        if (notes.length) result.meta.note = notes.join(' ');
        const encoded = encode(result, format, size);

        // Settle only now that the work exists, so nobody is charged for a
        // response they never received.
        const extra = {};
        if (payment && ctx.payments.settles) {
          const settlement = await settlePayment(ctx.payments, payment, requirements);
          if (!settlement.settled) {
            throw new HttpError(402, `Payment could not be settled: ${settlement.reason ?? 'unknown'}`);
          }
          extra['x-payment-response'] = settlementHeader(settlement);
        }

        return send(res, 200, encoded.type, encoded.body, encoded.meta, verdict, extra);
      }

      // ── MCP ────────────────────────────────────────────────────────────
      // The endpoint OKX.AI lists and calls. A2MCP requires the Model Context
      // Protocol here, not a REST shape: an MCP client that receives a plain
      // HTTP error waits for a stream that never arrives and reports a timeout,
      // which is exactly how the first listing was rejected.
      if (url.pathname === '/mcp') {
        if (req.method === 'GET' || req.method === 'DELETE') {
          const accept = String(req.headers.accept ?? '');

          // A real MCP client GETs this path to open a server→client SSE
          // stream. We do not offer one, and the spec says to answer 405 —
          // so clients that ask for a stream get the honest answer.
          if (accept.includes('text/event-stream')) {
            res.writeHead(405, { allow: 'POST', 'access-control-allow-origin': '*' });
            return res.end();
          }

          // Anything else reaching this path is a probe, not a protocol client:
          // the marketplace checks a listed endpoint by simply fetching it, and
          // a bare 405 reads as "this service is not answering" — which is what
          // the first listing was rejected for. Answer it with something true
          // and useful instead.
          const body = JSON.stringify({
            protocol: 'mcp',
            transport: 'streamable-http',
            usage: 'POST a JSON-RPC 2.0 message to this URL. Start with initialize, then tools/list.',
            tools: ['marble', 'wallet_portrait'],
            price: ctx.payments.enabled ? ctx.payments.display : '0',
            docs: `${publicOrigin(req, url)}/`,
          });
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            allow: 'POST, GET',
            'access-control-allow-origin': '*',
          });
          return res.end(body);
        }
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for MCP.');

        const body = await readJson(req);
        const messages = Array.isArray(body) ? body : [body];

        // The x402 gate, and it sits *here* rather than in front of the route
        // for a reason. MCP runs initialize, tools/list and tools/call over one
        // path; only the method in the body tells them apart. Gating the path
        // prices the handshake, and that is what the last listing was rejected
        // for: "charges initiated outside the tool/call stage". So the body is
        // read first and only the work is charged for. Discovery — initialize,
        // ping, tools/list, and the manifests at `/` and `/.well-known/x402` —
        // stays free, which is also where a client is supposed to look before
        // it pays.
        const chargeable = messages.some(
          (m) => m && typeof m === 'object' && m.method === 'tools/call',
        );
        if (ctx.payments.enabled && chargeable && !req.headers['x-payment']) {
          const origin = publicOrigin(req, url);
          const challenge = JSON.stringify(
            challengeBody(ctx.payments, {
              resource: `${origin}/mcp`,
              description: MCP_RESOURCE_DESCRIPTION,
            }),
          );
          res.writeHead(402, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(challenge),
            'access-control-allow-origin': '*',
            // v2 callers read the challenge from a header as well as the body.
            'payment-required': Buffer.from(challenge).toString('base64'),
          });
          return res.end(challenge);
        }

        // Only a genuine JSON-RPC notification may go unanswered. Everything
        // else must get a body back, whatever shape it arrived in: a caller
        // that receives an empty 202 has no way to tell success from silence,
        // and silence is precisely what the listing was rejected for twice.
        const isRpc = (m) => m && typeof m === 'object' && typeof m.method === 'string';
        const isNotification = (m) => isRpc(m) && (m.id === undefined || m.id === null);

        if (!messages.some(isRpc)) {
          const reply = await unrecognizedPost(messages[0], ctx, url);
          const out = JSON.stringify(reply);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(out),
            'access-control-allow-origin': '*',
          });
          return res.end(out);
        }

        const replies = [];
        for (const msg of messages) {
          const reply = await handleRpc(msg, ctx);
          if (reply) replies.push(reply);
        }

        // Every message really was a notification — the one case the protocol
        // says to acknowledge without a body.
        if (!replies.length && messages.every(isNotification)) {
          res.writeHead(202, { 'access-control-allow-origin': '*' });
          return res.end();
        }

        const payload = Array.isArray(body) ? replies : replies[0];
        const accept = String(req.headers.accept ?? '');

        if (accept.includes('text/event-stream')) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'access-control-allow-origin': '*',
          });
          res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return res.end();
        }

        const json = JSON.stringify(payload);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(json),
          'access-control-allow-origin': '*',
        });
        return res.end(json);
      }

      // Unmatched path. Say where the service actually is rather than a bare
      // "not found" — a prober that lands here should leave knowing how to call us.
      return fail(res, 404, `Not found — the MCP endpoint is POST ${publicOrigin(req, url)}/mcp. Service manifest: GET ${publicOrigin(req, url)}/.well-known/x402`);
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message, err.headers);
      // Never leak a stack to a caller, but never go silent either.
      console.error('[ebru]', err);
      return fail(res, 500, 'Render failed.');
    }
  }
}

/**
 * The default instance, used when the platform hands us (req, res) directly and
 * there is nowhere to thread options through.
 */
const defaultContext = makeContext();

export async function ebruHandler(req, res) {
  return handle(req, res, defaultContext);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.rendersPerMinute] per-caller render budget
 * @param {number} [opts.maxInFlight]      concurrent renders allowed
 * @param {number} [opts.cacheSize]        entries kept
 */
export function createEbruServer(opts) {
  const ctx = makeContext(opts);
  return createServer((req, res) => handle(req, res, ctx));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createEbruServer().listen(port, () => {
    console.log(`ebru serving on http://127.0.0.1:${port}`);
    console.log(`  free  GET /marble?seed=merhaba`);
    console.log(`  paid  GET /portrait?address=0x…&block=12345678`);
  });
}
