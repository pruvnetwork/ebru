#!/usr/bin/env node
/**
 * The test run. No framework — the engine has one dependency and the tests
 * should not add more.
 *
 *   node test/run.js
 *
 * The point of these is not coverage but the two claims the product makes:
 * that a seed always produces the same sheet, and that a portrait can be read
 * back — every legend entry must point at the drop it says it points at.
 */

import { createHash } from 'node:crypto';
import { render, renderReading, PATTERN_NAMES, PALETTE_NAMES, analyse, chooseGesture } from '../src/index.js';
import { toPng } from '../src/raster.js';
import { createServer } from 'node:http';
import { createEbruServer } from '../src/service.js';

let passed = 0;
const failures = [];
let group = '';

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

function section(name) {
  group = name;
  console.log(`\n${name}`);
}

/**
 * Must be awaited. An earlier version of this ran async checks without
 * awaiting them, so ten service tests reported "ok" while their assertions
 * were still pending and their failures escaped entirely — a green run that
 * proved nothing.
 */
async function check(what, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ok    ${what}${detail ? `  ${detail}` : ''}`);
  } catch (err) {
    failures.push(`${group} › ${what}: ${err.message}`);
    console.log(`  FAIL  ${what}\n          ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ------------------------------------------------------------------ */
section('determinism');

await check('same seed, same bytes, across interleaved renders', () => {
  const a = sha(render('kazanan', { width: 500, height: 500 }).svg);
  render('something-else-entirely', { width: 300, height: 300 });
  renderReading({ address: '0xabc', block: 1, events: [] }, { width: 300, height: 300 });
  const b = sha(render('kazanan', { width: 500, height: 500 }).svg);
  assert(a === b, `${a} != ${b}`);
  return a;
});

await check('distinct seeds diverge', () => {
  const seen = new Set();
  for (const s of ['a', 'b', 'c', 'd', 'e', 'ebru', 'Ebru', 'ebru ']) {
    seen.add(sha(render(s, { width: 240, height: 240 }).svg));
  }
  assert(seen.size === 8, `expected 8 distinct, got ${seen.size}`);
  return `${seen.size} distinct`;
});

await check('rasterised PNG is stable too', () => {
  const one = sha(toPng(render('raster', { width: 400, height: 400 }).svg, { width: 400 }));
  const two = sha(toPng(render('raster', { width: 400, height: 400 }).svg, { width: 400 }));
  assert(one === two, 'png differed between renders');
  return one;
});

await check('a reading is stable, and pinned block changes it', () => {
  const events = [{ hash: '0x1', ts: 1000, value: 5, token: 'OKB' }];
  const at10 = sha(renderReading({ address: '0xaa', block: 10, events }, { width: 300, height: 300 }).svg);
  const again = sha(renderReading({ address: '0xaa', block: 10, events }, { width: 300, height: 300 }).svg);
  const at11 = sha(renderReading({ address: '0xaa', block: 11, events }, { width: 300, height: 300 }).svg);
  assert(at10 === again, 'same block gave different bytes');
  assert(at10 !== at11, 'different block gave identical bytes — block is not in the seed');
  return `${at10} vs ${at11}`;
});

/* ------------------------------------------------------------------ */
section('coverage of patterns and palettes');

await check('every pattern renders and puts paint down', () => {
  for (const p of PATTERN_NAMES) {
    const { svg, meta } = render(`cover-${p}`, { width: 320, height: 320, pattern: p });
    assert(meta.drops > 0, `${p}: no drops`);
    assert(svg.includes('<path'), `${p}: no geometry`);
    assert(!svg.includes('NaN'), `${p}: NaN leaked into path data`);
  }
  return `${PATTERN_NAMES.length} patterns`;
});

await check('every palette renders', () => {
  for (const p of PALETTE_NAMES) {
    const { svg, meta } = render(`cover-${p}`, { width: 260, height: 260, palette: p });
    assert(meta.palette === p, `asked for ${p}, got ${meta.palette}`);
    assert(!svg.includes('NaN'), `${p}: NaN in output`);
  }
  return `${PALETTE_NAMES.length} palettes`;
});

await check('forcing pattern does not shift palette choice', () => {
  const free = render('stability', { width: 240, height: 240 });
  const forced = render('stability', { width: 240, height: 240, pattern: 'battal' });
  assert(free.meta.palette === forced.meta.palette, 'palette moved when pattern was forced');
  return free.meta.palette;
});

/* ------------------------------------------------------------------ */
section('awkward seeds');

for (const [label, seed] of [
  ['empty string', ''],
  ['single space', ' '],
  ['unicode', 'ebru — çğıöşü 🌀 مرمر'],
  ['very long', 'x'.repeat(20000)],
  ['looks numeric', '0'],
  ['address-like', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
]) {
  await check(`renders: ${label}`, () => {
    const { svg, meta } = render(seed, { width: 200, height: 200 });
    assert(meta.drops > 0, 'no drops');
    assert(!svg.includes('NaN'), 'NaN in output');
    return `${meta.pattern}/${meta.palette}`;
  });
}

/* ------------------------------------------------------------------ */
section('reading: behaviour drives the gesture');

const DAY = 86400;
const mk = (n, fn) => Array.from({ length: n }, (_, i) => ({ hash: `0x${i}`, ...fn(i) }));

await check('few movements read as battal', () => {
  const events = mk(6, (i) => ({ ts: 1e9 + i * 40 * DAY, value: 50000, token: 'OKB' }));
  const g = chooseGesture(analyse({ address: '0x1', events }));
  assert(g.pattern === 'battal', `got ${g.pattern}`);
  return g.pattern;
});

await check('metronome reads as tarakli', () => {
  const events = mk(200, (i) => ({ ts: 1e9 + i * DAY, value: 1000, token: 'OKB', counterparty: `0xp${i % 3}` }));
  const g = chooseGesture(analyse({ address: '0x2', events }));
  assert(g.pattern === 'tarakli', `got ${g.pattern}`);
  return g.pattern;
});

await check('bursts read as bulbul', () => {
  const events = [];
  let t = 1e9;
  for (let b = 0; b < 6; b++) {
    t += 40 * DAY;
    for (let i = 0; i < 30; i++) events.push({ hash: `0x${b}_${i}`, ts: t + i * 600, value: 500, token: 'OKB', counterparty: `0xd${i % 4}` });
  }
  const g = chooseGesture(analyse({ address: '0x3', events }));
  assert(g.pattern === 'bulbul', `got ${g.pattern}`);
  return g.pattern;
});

await check('one dominant counterparty reads as hatip', () => {
  const events = mk(80, (i) => ({
    ts: 1e9 + i * (1 + (i % 7)) * DAY,
    value: 1000 + (i % 5) * 300,
    token: 'USDT',
    counterparty: i % 10 === 0 ? `0xother${i}` : '0xlend',
  }));
  const g = chooseGesture(analyse({ address: '0x4', events }));
  assert(g.pattern === 'hatip', `got ${g.pattern}`);
  return g.pattern;
});

await check('dust farming reads as kumlu', () => {
  const events = mk(300, (i) => ({
    ts: 1e9 + i * (1 + (i % 3)) * DAY,
    value: i === 150 ? 200000 : 1 + (i % 4),
    token: 'USDT',
    counterparty: `0xf${i % 12}`,
  }));
  const g = chooseGesture(analyse({ address: '0x5', events }));
  assert(g.pattern === 'kumlu', `got ${g.pattern}`);
  return g.pattern;
});

/* ------------------------------------------------------------------ */
section('reading: the legend must be trustworthy');

await check('every legend entry maps to its own transaction', () => {
  const events = mk(40, (i) => ({
    ts: 1e9 + i * 3 * DAY,
    value: (i + 1) * 100,
    token: ['OKB', 'USDT', 'xETH'][i % 3],
    counterparty: `0xc${i % 5}`,
  }));
  const { legend, meta } = renderReading({ address: '0xleg', block: 7, events }, { width: 500, height: 500 });

  assert(legend.length === events.length, `legend has ${legend.length}, history has ${events.length}`);
  for (let i = 0; i < events.length; i++) {
    assert(legend[i].hash === events[i].hash, `entry ${i} points at ${legend[i].hash}, expected ${events[i].hash}`);
    assert(legend[i].token === events[i].token, `entry ${i} token mismatch`);
    assert(legend[i].value === events[i].value, `entry ${i} value mismatch`);
  }
  const ids = new Set(legend.map((e) => e.dropId));
  assert(ids.size === legend.length, 'two transactions share a drop id');
  return `${legend.length} entries, ${meta.key.length} pigments`;
});

await check('visible entries carry a real position', () => {
  const events = mk(25, (i) => ({ ts: 1e9 + i * 5 * DAY, value: 900, token: 'OKB' }));
  const { legend } = renderReading({ address: '0xpos', block: 3, events }, { width: 400, height: 400 });
  const visible = legend.filter((e) => e.visible);
  assert(visible.length > 0, 'nothing visible at all');
  for (const e of visible) {
    assert(Number.isFinite(e.x) && Number.isFinite(e.y), `entry ${e.hash} has non-finite position`);
    assert(e.share >= 0, `entry ${e.hash} has negative share`);
  }
  return `${visible.length}/${legend.length} visible`;
});

await check('legend colours agree with the declared key', () => {
  const events = mk(30, (i) => ({ ts: 1e9 + i * 2 * DAY, value: 500, token: ['A', 'B', 'C', 'D'][i % 4] }));
  const { legend, meta } = renderReading({ address: '0xkey', block: 5, events }, { width: 380, height: 380 });
  const byToken = new Map(meta.key.map((k) => [k.token, k.color]));
  for (const e of legend) {
    assert(byToken.get(e.token) === e.color, `${e.token} drawn ${e.color}, key says ${byToken.get(e.token)}`);
  }
  return `${byToken.size} tokens`;
});

/* ------------------------------------------------------------------ */
section('reading: malformed histories');

await check('no events at all', () => {
  const { svg, meta, legend } = renderReading({ address: '0xempty', block: 1, events: [] }, { width: 300, height: 300 });
  assert(legend.length === 0, 'legend not empty');
  assert(meta.drops > 0, 'nothing drawn — a sparse account must still get a sheet');
  assert(!svg.includes('NaN'), 'NaN in output');
  return `${meta.drops} ground drops`;
});

await check('a single event', () => {
  const { meta, legend } = renderReading(
    { address: '0xone', block: 1, events: [{ hash: '0xa', ts: 5, value: 3, token: 'OKB' }] },
    { width: 300, height: 300 },
  );
  assert(legend.length === 1, 'legend wrong length');
  assert(meta.burstiness === 0, 'burstiness should be 0 with no gaps');
  return meta.patternLabel;
});

await check('events missing value, token and hash', () => {
  const events = [{ ts: 10 }, { ts: 20 }, { ts: 30 }];
  const { legend, meta } = renderReading({ address: '0xbare', block: 1, events }, { width: 300, height: 300 });
  assert(legend.length === 3, 'legend wrong length');
  assert(legend.every((e) => e.token === 'native'), 'missing token not defaulted');
  assert(!Number.isNaN(meta.drops), 'drops NaN');
  return 'defaulted cleanly';
});

await check('events arrive out of order and are sorted', () => {
  const jumbled = [
    { hash: '0xc', ts: 300, value: 3 },
    { hash: '0xa', ts: 100, value: 1 },
    { hash: '0xb', ts: 200, value: 2 },
  ];
  const { legend } = renderReading({ address: '0xsort', block: 1, events: jumbled }, { width: 260, height: 260 });
  assert(legend.map((e) => e.hash).join() === '0xa,0xb,0xc', `order was ${legend.map((e) => e.hash).join()}`);
  return 'oldest first';
});

await check('identical timestamps do not divide by zero', () => {
  const events = mk(20, () => ({ ts: 1000, value: 10, token: 'OKB' }));
  const { svg, meta } = renderReading({ address: '0xsame', block: 1, events }, { width: 260, height: 260 });
  assert(Number.isFinite(meta.burstiness), `burstiness is ${meta.burstiness}`);
  assert(!svg.includes('NaN'), 'NaN in output');
  return `burstiness ${meta.burstiness}`;
});

await check('negative and zero values are tolerated', () => {
  const events = [
    { hash: '0xa', ts: 1, value: -500, token: 'OKB' },
    { hash: '0xb', ts: 2, value: 0, token: 'OKB' },
    { hash: '0xc', ts: 3, value: 1e18, token: 'OKB' },
  ];
  const { svg, meta } = renderReading({ address: '0xneg', block: 1, events }, { width: 260, height: 260 });
  assert(!svg.includes('NaN'), 'NaN in output');
  assert(meta.drops > 0, 'nothing drawn');
  return 'clamped';
});

await check('missing address is rejected', () => {
  let threw = false;
  try {
    renderReading({ events: [] }, { width: 200, height: 200 });
  } catch {
    threw = true;
  }
  assert(threw, 'accepted a reading with no address');
  return 'throws';
});

/* ------------------------------------------------------------------ */
section('service');

const server = createEbruServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

await check('manifest lists both services', async () => {
  const r = await fetch(`${base}/`);
  const j = await r.json();
  assert(r.status === 200, `status ${r.status}`);
  assert(j.services.length === 2, `${j.services.length} services`);
  return j.services.map((s) => s.path).join(' ');
});

await check('free endpoint returns a png', async () => {
  const r = await fetch(`${base}/marble?seed=test&size=200`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(r.status === 200, `status ${r.status}`);
  assert(r.headers.get('content-type') === 'image/png', 'wrong content-type');
  // PNG magic number.
  assert(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'not a PNG');
  assert(r.headers.get('x-ebru-seed') === 'test', 'provenance header missing');
  return `${buf.length}B`;
});

await check('svg and json formats work', async () => {
  const svg = await fetch(`${base}/marble?seed=fmt&format=svg&size=200`);
  const text = await svg.text();
  assert(text.startsWith('<svg'), 'svg body wrong');

  const json = await fetch(`${base}/marble?seed=fmt&format=json&size=200`);
  const j = await json.json();
  assert(j.image.startsWith('data:image/png;base64,'), 'json image wrong');
  assert(j.meta.pattern, 'json meta missing');
  return 'svg + json';
});

await check('cache returns identical bytes and is much faster', async () => {
  const t0 = performance.now();
  const a = Buffer.from(await (await fetch(`${base}/marble?seed=cache-me&size=300`)).arrayBuffer());
  const cold = performance.now() - t0;

  const t1 = performance.now();
  const b = Buffer.from(await (await fetch(`${base}/marble?seed=cache-me&size=300`)).arrayBuffer());
  const warm = performance.now() - t1;

  assert(a.equals(b), 'cached response differed');
  assert(warm < cold, `warm ${warm.toFixed(0)}ms not faster than cold ${cold.toFixed(0)}ms`);
  return `${cold.toFixed(0)}ms → ${warm.toFixed(1)}ms`;
});

await check('size is clamped, not trusted', async () => {
  const big = await fetch(`${base}/marble?seed=clamp&size=99999&format=json`);
  const j = await big.json();
  assert(big.status === 200, `status ${big.status}`);
  const tiny = await fetch(`${base}/marble?seed=clamp&size=-5&format=json`);
  assert(tiny.status === 200, `negative size gave ${tiny.status}`);
  return 'clamped both ends';
});

await check('bad input is refused with a usable message', async () => {
  const cases = [
    [`${base}/marble`, 400],
    [`${base}/marble?seed=x&pattern=nope`, 400],
    [`${base}/marble?seed=x&palette=nope`, 400],
    [`${base}/marble?seed=x&format=gif`, 400],
    [`${base}/portrait`, 400],
    [`${base}/portrait?address=0x1&block=abc`, 400],
    [`${base}/nowhere`, 404],
  ];
  for (const [url, want] of cases) {
    const r = await fetch(url);
    assert(r.status === want, `${url} gave ${r.status}, wanted ${want}`);
    const j = await r.json();
    assert(typeof j.error === 'string' && j.error.length > 0, `${url} gave no error message`);
  }
  return `${cases.length} cases`;
});

await check('portrait degrades to address-only rather than failing', async () => {
  const r = await fetch(`${base}/portrait?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&block=21500000`);
  const j = await r.json();
  assert(r.status === 200, `status ${r.status}`);
  assert(j.meta.source === 'address-only', `source ${j.meta.source}`);
  assert(typeof j.meta.note === 'string', 'no note explaining the degradation');
  return j.meta.patternLabel;
});

await check('portrait reads caller-supplied history', async () => {
  const events = mk(45, (i) => ({
    ts: 1e9 + i * (1 + (i % 6)) * DAY,
    value: 100 + i * 20,
    token: ['USDT', 'OKB'][i % 2],
    counterparty: i % 8 === 0 ? '0xother' : '0xlend',
  }));
  const r = await fetch(`${base}/portrait?format=json&size=300`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: '0xfeed', block: 999, events }),
  });
  const j = await r.json();
  assert(r.status === 200, `status ${r.status}`);
  assert(j.meta.source === 'caller-supplied', `source ${j.meta.source}`);
  assert(j.legend.length === events.length, `legend ${j.legend.length} vs ${events.length}`);
  assert(j.meta.block === 999, 'block not carried through');
  assert(!j.meta.note, 'degradation note present despite real data');
  return `${j.legend.length} entries, ${j.meta.patternLabel}`;
});

await check('oversized body is refused', async () => {
  const r = await fetch(`${base}/portrait`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: '0x1', events: mk(60000, (i) => ({ ts: i, value: i, token: 'PADDINGPADDINGPADDING' })) }),
  });
  assert(r.status === 413, `status ${r.status}`);
  return '413';
});

await check('malformed json body is refused', async () => {
  const r = await fetch(`${base}/portrait?address=0x1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert(r.status === 400, `status ${r.status}`);
  return '400';
});


/* ------------------------------------------------------------------ */
section('rate limiting');

// Its own server, so the budget these tests spend is not the budget the rest of
// the suite already spent from the same address.
const limited = createEbruServer({ rendersPerMinute: 5, maxInFlight: 4 });
await new Promise((r) => limited.listen(0, r));
const lbase = `http://127.0.0.1:${limited.address().port}`;

await check('cache hits are never metered', async () => {
  const first = await fetch(`${lbase}/marble?seed=unmetered&size=160`);
  assert(first.status === 200, `priming call gave ${first.status}`);
  assert(first.headers.get('x-ratelimit-remaining') !== null, 'primed render was not metered');

  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${lbase}/marble?seed=unmetered&size=160`);
    assert(r.status === 200, `repeat ${i} gave ${r.status}`);
    assert(r.headers.get('x-ratelimit-remaining') === null, `repeat ${i} consumed budget`);
  }
  return '30 repeats past the limit, none metered';
});

await check('new seeds are metered and eventually refused', async () => {
  let refused = null;
  let served = 0;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${lbase}/marble?seed=probe-${i}&size=140`);
    if (r.status === 429) { refused = r; break; }
    assert(r.status === 200, `call ${i} gave ${r.status}`);
    served++;
  }
  assert(refused, `never refused after ${served} distinct renders`);
  const retry = refused.headers.get('retry-after');
  assert(retry && Number(retry) > 0, `no usable retry-after (got ${retry})`);
  const body = await refused.json();
  assert(/seed/i.test(body.error), 'refusal does not tell the caller what to do instead');
  return `served ${served}, then 429, retry-after ${retry}s`;
});

await check('a refused caller can still fetch cached work', async () => {
  const r = await fetch(`${lbase}/marble?seed=unmetered&size=160`);
  assert(r.status === 200, `cached fetch after refusal gave ${r.status}`);
  assert(r.headers.get('x-ratelimit-remaining') === null, 'cached fetch was metered');
  return 'served from cache while refused for new work';
});

await check('budgets are per service instance, not global', async () => {
  // The exhausted instance above must not have starved the main server.
  const r = await fetch(`${base}/marble?seed=isolation-check&size=140`);
  assert(r.status === 200, `main server gave ${r.status}`);
  return 'isolated';
});

limited.closeAllConnections();
await new Promise((r) => limited.close(r));


/* ------------------------------------------------------------------ */
section('x402 payments');

// A stand-in facilitator whose verdicts the tests control.
let facilitatorVerdict = { verify: true, settle: true };
let facilitatorDown = false;
const facilitator = createServer((req, res) => {
  if (facilitatorDown) { req.destroy(); return; }
  const ok = req.url === '/verify'
    ? { isValid: facilitatorVerdict.verify, invalidReason: 'stub says no' }
    : { success: facilitatorVerdict.settle, transaction: '0xstub' };
  const body = JSON.stringify(ok);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((r) => facilitator.listen(0, r));
const fbase = `http://127.0.0.1:${facilitator.address().port}`;

const paidPayments = {
  enabled: true,
  settles: true,
  payTo: '0xPayToAddress',
  facilitator: fbase,
  asset: '0xUSDT0',
  network: 'xlayer',
  price: '10000',
  decimals: 6,
  display: '0.01 USDT0',
};
const paid = createEbruServer({ payments: paidPayments, rendersPerMinute: 200 });
await new Promise((r) => paid.listen(0, r));
const pbase = `http://127.0.0.1:${paid.address().port}`;

const pay = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

await check('manifest advertises the real price when payments are on', async () => {
  const m = await (await fetch(`${pbase}/`)).json();
  assert(m.services[1].price === '0.01 USDT0', `price is ${m.services[1].price}`);
  assert(m.services[1].payment.protocol === 'x402', 'payment protocol not declared');
  return m.services[1].price;
});

await check('unpaid request gets a well-formed 402 challenge', async () => {
  const r = await fetch(`${pbase}/portrait?address=0xabc&block=1`);
  assert(r.status === 402, `status ${r.status}`);
  const body = await r.json();
  assert(body.x402Version === 1, 'no x402Version');
  assert(Array.isArray(body.accepts) && body.accepts.length === 1, 'no accepts array');
  const a = body.accepts[0];
  assert(a.scheme === 'exact', `scheme ${a.scheme}`);
  assert(a.payTo === '0xPayToAddress', 'payTo missing');
  assert(a.asset === '0xUSDT0', 'asset missing');
  assert(a.maxAmountRequired === '10000', 'amount missing');
  assert(typeof a.resource === 'string' && a.resource.includes('/portrait'), 'resource missing');
  return `${a.scheme} ${a.maxAmountRequired} on ${a.network}`;
});

await check('a verified payment is served, and settlement is reported', async () => {
  facilitatorVerdict = { verify: true, settle: true };
  const r = await fetch(`${pbase}/portrait?address=0xabc&block=1`, {
    headers: { 'x-payment': pay({ scheme: 'exact', payload: 'stub' }) },
  });
  assert(r.status === 200, `status ${r.status}`);
  const receipt = r.headers.get('x-payment-response');
  assert(receipt, 'no x-payment-response header');
  const decoded = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
  assert(decoded.success === true, 'receipt does not report success');
  return 'served + settled';
});

await check('a rejected payment is refused', async () => {
  facilitatorVerdict = { verify: false, settle: true };
  const r = await fetch(`${pbase}/portrait?address=0xdef&block=1`, {
    headers: { 'x-payment': pay({ scheme: 'exact', payload: 'bad' }) },
  });
  assert(r.status === 402, `status ${r.status}`);
  const body = await r.json();
  assert(/verified/i.test(body.error), `unhelpful error: ${body.error}`);
  return '402';
});

await check('a malformed X-PAYMENT header falls back to the challenge', async () => {
  const r = await fetch(`${pbase}/portrait?address=0xabc&block=1`, {
    headers: { 'x-payment': 'not-base64-json!!' },
  });
  assert(r.status === 402, `status ${r.status}`);
  const body = await r.json();
  assert(Array.isArray(body.accepts), 'did not re-issue the challenge');
  return 'challenge re-issued';
});

await check('an unreachable facilitator fails closed, never open', async () => {
  facilitatorDown = true;
  const r = await fetch(`${pbase}/portrait?address=0xghi&block=1`, {
    headers: { 'x-payment': pay({ scheme: 'exact', payload: 'stub' }) },
  });
  facilitatorDown = false;
  // The dangerous bug would be 200: anyone could take the paid service for free
  // by cutting our link to the facilitator.
  assert(r.status === 402, `status ${r.status} — service was given away for free`);
  return 'refused';
});

await check('failed settlement does not silently serve', async () => {
  facilitatorVerdict = { verify: true, settle: false };
  const r = await fetch(`${pbase}/portrait?address=0xjkl&block=1`, {
    headers: { 'x-payment': pay({ scheme: 'exact', payload: 'stub' }) },
  });
  assert(r.status === 402, `status ${r.status}`);
  return '402';
});

await check('the free endpoint is never gated by payment', async () => {
  const r = await fetch(`${pbase}/marble?seed=still-free&size=140`);
  assert(r.status === 200, `status ${r.status}`);
  return 'free';
});

// The listing was rejected for charging outside the tool/call stage. These four
// are that rejection, written down: MCP runs the whole protocol over one route,
// so nothing but the method in the body separates the handshake from the work.
const rpc = (method, params) =>
  fetch(`${pbase}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
  });

// The OKX middleware settles a verified payment unless `res.statusCode` is 4xx
// or 5xx — and it learns the status by buffering our response through a
// replaced `res.writeHead`, which does not set `statusCode` on its own. If our
// refusals do not set it too, a caller who paid and then got an error is
// charged for the error. Reproduce the middleware's mechanism exactly and check
// what it would decide.
await check('a refused request would not be settled for', async () => {
  const target = createEbruServer({ rendersPerMinute: 200 });
  const realHandler = target.listeners('request')[0];
  const seen = [];
  const spy = createServer((req, res) => {
    // Exactly what @okxweb3/x402-express does: buffer the response, wait for
    // end, read statusCode to decide on settlement, then flush.
    const original = { writeHead: res.writeHead.bind(res), write: res.write.bind(res), end: res.end.bind(res) };
    const buffered = [];
    let markEnded;
    const ended = new Promise((r) => { markEnded = r; });
    res.writeHead = (...a) => { buffered.push(['writeHead', a]); return res; };
    res.write = (...a) => { buffered.push(['write', a]); return true; };
    res.end = (...a) => { buffered.push(['end', a]); markEnded(); return res; };
    realHandler(req, res);
    ended.then(() => {
      seen.push(res.statusCode); // the settlement decision reads this
      Object.assign(res, original);
      for (const [m, a] of buffered) original[m](...a);
    });
  });
  await new Promise((r) => spy.listen(0, r));
  const base = `http://127.0.0.1:${spy.address().port}`;
  // A refusal the service issues for real: no seed.
  await fetch(`${base}/marble`);
  spy.closeAllConnections();
  await new Promise((r) => spy.close(r));
  assert(seen.length === 1, `expected one response, saw ${seen.length}`);
  assert(
    seen[0] >= 400,
    `the middleware would read statusCode ${seen[0]} and settle a payment for a refused request`,
  );
  return `statusCode ${seen[0]} — refusal is visible, no settlement`;
});

// Twice now the manifest has quoted a price the endpoint did not honour — once
// advertising free while /mcp charged, once the reverse. Walk what it claims and
// call each path to see whether the claim holds.
await check('every price the manifest quotes is the price the path charges', async () => {
  const m = await (await fetch(`${pbase}/`)).json();
  const checked = [];
  for (const s of m.services) {
    const probe = s.path === '/portrait' ? `${s.path}?address=0xabc&block=1` : `${s.path}?seed=x&size=140`;
    const r = await fetch(`${pbase}${probe}`);
    const charges = r.status === 402;
    const claims = s.price !== '0';
    assert(
      charges === claims,
      `${s.path} advertises "${s.price}" but answered ${r.status}`,
    );
    checked.push(`${s.path}=${s.price}`);
  }
  return checked.join(' ');
});

await check('the MCP handshake is never charged for', async () => {
  const results = [];
  for (const method of ['initialize', 'ping', 'tools/list', 'resources/list', 'prompts/list']) {
    const r = await rpc(method);
    assert(r.status !== 402, `${method} answered 402 — this is the rejection reason`);
    assert(r.status === 200, `${method} answered ${r.status}`);
    results.push(method);
  }
  return `${results.length} methods free`;
});

await check('tools/list returns the tools without a payment header', async () => {
  const body = await (await rpc('tools/list')).json();
  const names = (body.result?.tools ?? []).map((t) => t.name);
  assert(names.includes('marble'), `tools missing: ${names.join(',')}`);
  return names.join(', ');
});

await check('tools/call is the stage that charges', async () => {
  const r = await rpc('tools/call', { name: 'marble', arguments: { seed: 'paid', size: 140 } });
  assert(r.status === 402, `tools/call answered ${r.status} — the work is not being charged for`);
  const body = await r.json();
  assert(Array.isArray(body.accepts) && body.accepts.length === 1, 'no challenge on tools/call');
  return `402 on tools/call, ${body.accepts[0].maxAmountRequired}`;
});

// The platform refuses a response over 4.5 MB, and the payment middleware
// settles before it flushes — so a reply too big to send is a reply the caller
// paid for and never got. The densest pattern at the largest accepted size is
// the worst case; keep it under the limit.
await check('the largest tool result still fits the response limit', async () => {
  const free = createEbruServer({ rendersPerMinute: 200 });
  await new Promise((r) => free.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${free.address().port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      // size is deliberately over the cap: the clamp is what is under test.
      params: { name: 'marble', arguments: { seed: 'worst case', pattern: 'bulbul', size: 4000 } },
    }),
  });
  const bytes = Buffer.byteLength(await r.text());
  free.closeAllConnections();
  await new Promise((r2) => free.close(r2));
  const mb = bytes / 1048576;
  assert(r.status === 200, `status ${r.status}`);
  assert(mb < 4.5, `${mb.toFixed(2)} MB — over the platform's 4.5 MB limit`);
  return `${mb.toFixed(2)} MB at the cap`;
});

await check('a batch containing tools/call is charged, one without it is not', async () => {
  const batch = (msgs) =>
    fetch(`${pbase}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msgs),
    });
  const free = await batch([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert(free.status === 200, `handshake batch answered ${free.status}`);
  // A batch must not become a way to smuggle the work past the gate.
  const paidBatch = await batch([
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'marble', arguments: { seed: 'x' } } },
  ]);
  assert(paidBatch.status === 402, `batch with tools/call answered ${paidBatch.status}`);
  return 'handshake 200, smuggled call 402';
});

paid.closeAllConnections();
await new Promise((r) => paid.close(r));
facilitator.closeAllConnections();
await new Promise((r) => facilitator.close(r));

// fetch keeps its sockets alive, and server.close() waits for them — without
// dropping them first the run hangs on a passing suite.
server.closeAllConnections();
await new Promise((r) => server.close(r));

/* ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
