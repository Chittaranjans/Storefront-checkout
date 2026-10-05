/**
 * Executable walkthrough of the API against a running server.
 *
 *   bun run start            # in one terminal
 *   bun run demo             # in another (or BASE_URL=http://localhost:8080 bun run demo)
 *
 * It exercises the happy path AND the interesting failure modes: retries,
 * double checkout, oversell under concurrency, and competing coupon redeemers.
 * Every step prints the request, the HTTP status, and the response body.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

type Res = { status: number; json: any };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function show(label: string, method: string, path: string, res: Res, body?: unknown) {
  console.log(`\n# ${label}`);
  console.log(`> ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
  console.log(`< ${res.status} ${JSON.stringify(res.json)}`);
}

async function step(label: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res> {
  const res = await call(method, path, body, headers);
  show(label, method, path, res, body);
  return res;
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`\nASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function newCart(productId: string, quantity: number): Promise<string> {
  const { json: cart } = await call('POST', '/carts');
  await call('POST', `/carts/${cart.id}/items`, { productId, quantity });
  return cart.id;
}

async function main() {
  const health = await step('Health / config', 'GET', '/health');
  const { n, x } = health.json.config as { n: number; x: number };

  await step('List products', 'GET', '/products');

  // ---------------------------------------------------------------- cart CRUD
  const { json: cart } = await step('Create cart', 'POST', '/carts');
  await step('Add 2x Wireless Mouse', 'POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 2 });
  await step('Add 1x Keyboard', 'POST', `/carts/${cart.id}/items`, { productId: 'p-101', quantity: 1 });
  await step('Change mouse quantity to 3', 'PATCH', `/carts/${cart.id}/items/p-100`, { quantity: 3 });
  await step('Remove keyboard', 'DELETE', `/carts/${cart.id}/items/p-101`);
  const view = await step('View cart', 'GET', `/carts/${cart.id}`);
  assert(view.json.subtotalCents === 7500, 'subtotal is 3 x 2500 = 7500 cents');

  // --------------------------------------------------------------- validation
  const badQty = await step('Invalid quantity is rejected', 'POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 0 });
  assert(badQty.status === 400 && badQty.json.error.code === 'INVALID_QUANTITY', '400 INVALID_QUANTITY');
  const badProduct = await step('Unknown product is rejected', 'POST', `/carts/${cart.id}/items`, { productId: 'nope', quantity: 1 });
  assert(badProduct.status === 404 && badProduct.json.error.code === 'PRODUCT_NOT_FOUND', '404 PRODUCT_NOT_FOUND');

  // ------------------------------------------------------ checkout + retry
  const key = `demo-${Date.now()}`;
  const first = await step('Checkout with Idempotency-Key', 'POST', `/carts/${cart.id}/checkout`, {}, { 'Idempotency-Key': key });
  assert(first.status === 201, 'order created');
  const retry = await step('Retry same request (client timed out)', 'POST', `/carts/${cart.id}/checkout`, {}, { 'Idempotency-Key': key });
  assert(retry.status === 201 && retry.json.id === first.json.id, 'retry returns the SAME order, no double charge');

  const again = await step('Checkout same cart again without key', 'POST', `/carts/${cart.id}/checkout`, {});
  assert(again.status === 409 && again.json.error.code === 'CART_ALREADY_CHECKED_OUT', '409 CART_ALREADY_CHECKED_OUT');
  assert(again.json.error.details.orderId === first.json.id, 'error tells the client which order already exists');

  await step('Retrieve the order', 'GET', `/orders/${first.json.id}`);
  const mutate = await step('Mutating a checked-out cart is rejected', 'POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 1 });
  assert(mutate.status === 409, '409 on mutation after checkout');

  // -------------------------------------------------- concurrent oversell
  console.log('\n# Concurrency: 10 carts race for the Limited Edition Desk Mat (p-104)');
  const before = (await call('GET', '/products')).json.products.find((p: any) => p.id === 'p-104');
  console.log(`  inventory before: ${before.inventory}`);
  const raceCarts = await Promise.all(Array.from({ length: 10 }, () => newCart('p-104', 1)));
  const raceResults = await Promise.all(raceCarts.map((id) => call('POST', `/carts/${id}/checkout`, {})));
  const won = raceResults.filter((r) => r.status === 201).length;
  const lost = raceResults.filter((r) => r.status === 409 && r.json.error.code === 'INSUFFICIENT_INVENTORY').length;
  const after = (await call('GET', '/products')).json.products.find((p: any) => p.id === 'p-104');
  console.log(`  201 created: ${won}, 409 INSUFFICIENT_INVENTORY: ${lost}, inventory after: ${after.inventory}`);
  assert(won === before.inventory && after.inventory === 0, `exactly ${before.inventory} succeeded, none oversold`);
  if (lost > 0) {
    const sample = raceResults.find((r) => r.status === 409)!;
    console.log(`  sample error: ${JSON.stringify(sample.json)}`);
  }

  // -------------------------------------------------------------- coupons
  let report = (await call('GET', '/admin/report')).json;
  console.log(`\n# Coupons: ${report.totalOrders} orders placed so far; a coupon unlocks every ${n} orders`);
  const needed = Math.ceil(report.totalOrders / n) * n - report.totalOrders;
  const toPlace = needed === 0 ? n : needed;
  for (let i = 0; i < toPlace; i++) {
    const id = await newCart('p-103', 1);
    await call('POST', `/carts/${id}/checkout`, {});
  }
  report = (await call('GET', '/admin/report')).json;
  console.log(`  placed ${toPlace} more -> ${report.totalOrders} orders`);

  const gen1 = await step('[admin] Generate coupon', 'POST', '/admin/coupons');
  assert(gen1.status === 201 && gen1.json.percent === x, `coupon for ${x}% generated at milestone ${gen1.json.milestone}`);
  const gen2 = await step('[admin] Generate again (same milestone)', 'POST', '/admin/coupons');
  assert(gen2.json.code === gen1.json.code, 'idempotent: same coupon returned, no duplicate');

  // Coupon survives a failed checkout
  const failing = await newCart('p-104', 1); // out of stock now
  const failed = await step('Checkout that fails WITH coupon', 'POST', `/carts/${failing}/checkout`, { couponCode: gen1.json.code });
  assert(failed.status === 409 && failed.json.error.code === 'INSUFFICIENT_INVENTORY', 'checkout fails on inventory');
  report = (await call('GET', '/admin/report')).json;
  assert(report.couponsAvailable === 1 && report.couponsRedeemed === 0, 'coupon NOT consumed by the failed checkout');

  // Competing redeemers
  console.log('\n# Concurrency: 6 carts race to redeem the same coupon');
  const redeemCarts = await Promise.all(Array.from({ length: 6 }, () => newCart('p-100', 2)));
  const redeemResults = await Promise.all(
    redeemCarts.map((id) => call('POST', `/carts/${id}/checkout`, { couponCode: gen1.json.code })),
  );
  const redeemed = redeemResults.filter((r) => r.status === 201);
  const refused = redeemResults.filter((r) => r.status === 409 && r.json.error.code === 'COUPON_ALREADY_REDEEMED');
  console.log(`  201 created: ${redeemed.length}, 409 COUPON_ALREADY_REDEEMED: ${refused.length}`);
  assert(redeemed.length === 1 && refused.length === 5, 'exactly one checkout redeemed the coupon');
  const winner = redeemed[0]!.json;
  console.log(`  winner: subtotal ${winner.subtotalCents}, ${winner.discountPercent}% off = -${winner.discountCents}, total ${winner.totalCents}`);
  assert(winner.totalCents === winner.subtotalCents - winner.discountCents, 'total = subtotal - discount (integer cents)');

  const reuse = await step('Reusing the redeemed coupon', 'POST', `/carts/${await newCart('p-100', 1)}/checkout`, { couponCode: gen1.json.code });
  assert(reuse.status === 409 && reuse.json.error.code === 'COUPON_ALREADY_REDEEMED', 'coupon can be redeemed only once');

  // ------------------------------------------------------------------ report
  const r1 = await step('[admin] Report', 'GET', '/admin/report');
  const r2 = await call('GET', '/admin/report');
  assert(JSON.stringify(r1.json) === JSON.stringify(r2.json), 'report is read-only (identical on repeat)');
  assert(r1.json.netRevenueCents === r1.json.grossRevenueCents - r1.json.totalDiscountCents, 'net = gross - discounts');
  assert(r1.json.couponsGenerated === r1.json.couponsAvailable + r1.json.couponsRedeemed, 'generated = available + redeemed');

  console.log('\nAll demo assertions passed.');
}

main().catch((err) => {
  console.error(`\nDemo failed. Is the server running at ${BASE}?`);
  console.error(err);
  process.exit(1);
});
