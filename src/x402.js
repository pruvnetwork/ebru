/**
 * x402 — HTTP-native payment for the paid service.
 *
 * The flow the protocol defines: an unpaid request gets 402 back with a
 * description of what payment would satisfy it; the caller pays and retries
 * with an `X-PAYMENT` header; the server verifies that payment with a
 * facilitator, serves the resource, and reports settlement back in
 * `X-PAYMENT-RESPONSE`.
 *
 * Payments are off unless fully configured, and that is deliberate rather than
 * lazy. A service that answers 402 to everything but has no working way to
 * accept a payment is worse than a free one: it looks like a product and
 * behaves like a wall. So if the receiving address or the facilitator is
 * missing, `/portrait` simply stays free and says so in the manifest.
 *
 * Configure with:
 *   EBRU_X402_PAY_TO        address that receives payment
 *   EBRU_X402_FACILITATOR   base URL that verifies and settles
 *   EBRU_X402_ASSET         token contract (USDT0 on X Layer)
 *   EBRU_X402_NETWORK       network id the facilitator expects
 *   EBRU_X402_PRICE         price in atomic units of the asset
 *   EBRU_X402_DECIMALS      decimals of the asset, for display only
 */

export const X402_VERSION = 1;

/**
 * What is being paid for, in one place.
 *
 * Both gates put this in the challenge they issue and the manifest repeats it,
 * so a caller comparing the two sees one resource rather than two descriptions
 * of what might be the same thing.
 */
export const MCP_RESOURCE_DESCRIPTION =
  'Ebru — Turkish paper marbling, computed. MCP tools: marble, wallet_portrait.';

export function paymentConfig(env = process.env) {
  const payTo = env.EBRU_X402_PAY_TO;
  const facilitator = env.EBRU_X402_FACILITATOR;
  const asset = env.EBRU_X402_ASSET;
  const network = env.EBRU_X402_NETWORK ?? 'xlayer';
  const price = env.EBRU_X402_PRICE ?? '10000';
  const decimals = Number(env.EBRU_X402_DECIMALS ?? 6);
  // EIP-712 domain of the payment token, read from the contract itself.
  const tokenName = env.EBRU_X402_TOKEN_NAME ?? 'USD\u20AE0';
  const tokenVersion = env.EBRU_X402_TOKEN_VERSION ?? '1';

  // Issuing a challenge needs only somewhere to pay and something to pay in.
  // Settling needs a facilitator on top — and settling is separable, because a
  // challenge is a *request* for payment, not a claim to have taken one.
  //
  // We run challenge-only on purpose. The marketplace validates a listed A2MCP
  // endpoint by requiring an x402 challenge (`x402-validate` refuses an endpoint
  // that answers 200) and its payment step cannot convert a zero amount, so the
  // price has to be real and small. But we do not want the money: a request that
  // arrives carrying a payment header is served without settlement, so the caller
  // signs an authorisation that is never drawn on and pays nothing.
  // When the official OKX middleware is configured it owns the 402 handshake.
  // Two gates on the same route would challenge a caller twice and neither
  // would agree on what was paid, so ours stands down.
  const sdkActive = Boolean(env.OKX_API_KEY && env.OKX_SECRET_KEY && env.OKX_PASSPHRASE && payTo);

  const priced = Number(price) > 0;
  const enabled = !sdkActive && Boolean(payTo && asset);
  const settles = Boolean(facilitator);
  const zeroPrice = !priced;

  return {
    enabled,
    /** The official SDK owns the handshake — ours is standing down, not off. */
    sdkActive,
    /** What the SDK actually charges, so the manifest can advertise it. */
    sdkPrice: env.EBRU_X402_USD_PRICE ?? '$0.001',
    settles,
    zeroPrice,
    payTo,
    facilitator: facilitator?.replace(/\/$/, ''),
    asset,
    network,
    price,
    decimals,
    tokenName,
    tokenVersion,
    /** Human-readable price, for the manifest and the listing. */
    display: priced ? `${Number(price) / 10 ** decimals} ${env.EBRU_X402_SYMBOL ?? 'USDT0'}` : '0',
  };
}

/**
 * What a caller must pay to get this resource. Sent as the body of the 402.
 */
export function paymentRequirements(config, { resource, description }) {
  return {
    scheme: 'exact',
    network: config.network,
    maxAmountRequired: String(config.price),
    resource,
    description,
    mimeType: 'application/json',
    payTo: config.payTo,
    maxTimeoutSeconds: 120,
    asset: config.asset,
    // Declares EIP-3009 (`transferWithAuthorization`) as the authorisation
    // method: the signer reads the token's EIP-712 domain from `extra.name` and
    // `extra.version`, and their presence — with no `assetTransferMethod` of
    // "permit2" — is what marks the entry as the 3009 path rather than Permit2.
    // A challenge without them cannot be signed at all, which is what the
    // marketplace flagged.
    extra: {
      name: config.tokenName,
      version: config.tokenVersion,
    },
  };
}

export function challengeBody(config, { resource, description }) {
  return {
    x402Version: X402_VERSION,
    error: 'X-PAYMENT header is required',
    accepts: [paymentRequirements(config, { resource, description })],
  };
}

/** Decode the caller's `X-PAYMENT` header. Returns null if it is unusable. */
export function decodePayment(header) {
  if (typeof header !== 'string' || !header.length) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function facilitatorCall(config, path, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.facilitator}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `facilitator returned ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'facilitator timed out' : 'facilitator unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the facilitator whether this payment is good for this resource.
 *
 * A failure to reach the facilitator is treated as *not paid*, never as paid.
 * Getting that backwards would let anyone take the service for free by breaking
 * our connection to the facilitator.
 */
export async function verifyPayment(config, payment, requirements, { timeoutMs = 6000 } = {}) {
  const result = await facilitatorCall(
    config,
    '/verify',
    { x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements },
    timeoutMs,
  );
  if (!result.ok) return { valid: false, reason: result.reason };
  const valid = result.body?.isValid === true;
  return { valid, reason: valid ? null : (result.body?.invalidReason ?? 'payment rejected') };
}

/**
 * Move the money. Called only after the work succeeded, so a caller is never
 * charged for a response they did not get.
 */
export async function settlePayment(config, payment, requirements, { timeoutMs = 12000 } = {}) {
  const result = await facilitatorCall(
    config,
    '/settle',
    { x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements },
    timeoutMs,
  );
  if (!result.ok) return { settled: false, reason: result.reason };
  return { settled: result.body?.success === true, receipt: result.body ?? null };
}

/** The header a caller reads to learn how their payment landed. */
export function settlementHeader(settlement) {
  return Buffer.from(JSON.stringify(settlement.receipt ?? { success: settlement.settled })).toString('base64');
}
