import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from '../src/server';
import { makeService } from './helpers';

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  const service = makeService();
  server = createServer(service);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  base = `http://localhost:${address.port}`;
});

afterAll(() => {
  server.close();
});

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

describe('HTTP API', () => {
  test('lists products', async () => {
    const { status, json } = await api('GET', '/products');
    expect(status).toBe(200);
    expect(json.products.length).toBeGreaterThanOrEqual(5);
  });

  test('full cart lifecycle over HTTP', async () => {
    const { json: cart } = await api('POST', '/carts');
    expect(cart.id).toBeTruthy();

    const add = await api('POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 2 });
    expect(add.status).toBe(200);
    expect(add.json.subtotalCents).toBe(5000);

    const update = await api('PATCH', `/carts/${cart.id}/items/p-100`, { quantity: 3 });
    expect(update.json.subtotalCents).toBe(7500);

    const checkout = await api('POST', `/carts/${cart.id}/checkout`, {});
    expect(checkout.status).toBe(201);
    expect(checkout.json.totalCents).toBe(7500);

    const order = await api('GET', `/orders/${checkout.json.id}`);
    expect(order.status).toBe(200);
    expect(order.json.id).toBe(checkout.json.id);
  });

  test('returns distinguishable error bodies', async () => {
    const { json: cart } = await api('POST', '/carts');

    const badProduct = await api('POST', `/carts/${cart.id}/items`, { productId: 'nope', quantity: 1 });
    expect(badProduct.status).toBe(404);
    expect(badProduct.json.error.code).toBe('PRODUCT_NOT_FOUND');

    const badQuantity = await api('POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 0 });
    expect(badQuantity.status).toBe(400);
    expect(badQuantity.json.error.code).toBe('INVALID_QUANTITY');

    const missingCart = await api('GET', '/carts/does-not-exist');
    expect(missingCart.status).toBe(404);
    expect(missingCart.json.error.code).toBe('CART_NOT_FOUND');
  });

  test('idempotency key header makes checkout retries safe', async () => {
    const { json: cart } = await api('POST', '/carts');
    await api('POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 1 });

    const first = await api('POST', `/carts/${cart.id}/checkout`, {}, { 'Idempotency-Key': 'http-key-1' });
    const retry = await api('POST', `/carts/${cart.id}/checkout`, {}, { 'Idempotency-Key': 'http-key-1' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.json.id).toBe(first.json.id);
  });

  test('admin coupon generation and report', async () => {
    const before = await api('POST', '/admin/coupons');
    expect(before.status).toBe(409);
    expect(before.json.error.code).toBe('MILESTONE_NOT_REACHED');

    const report = await api('GET', '/admin/report');
    expect(report.status).toBe(200);
    expect(typeof report.json.netRevenueCents).toBe('number');
  });

  test('unknown route returns 404', async () => {
    const res = await api('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });

  test('error bodies carry machine-readable details', async () => {
    const { json: cart } = await api('POST', '/carts');
    await api('POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: 1 });
    const first = await api('POST', `/carts/${cart.id}/checkout`, {});
    const second = await api('POST', `/carts/${cart.id}/checkout`, {});

    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('CART_ALREADY_CHECKED_OUT');
    expect(second.json.error.details.orderId).toBe(first.json.id);
  });

  test('rejects malformed JSON and wrong field types', async () => {
    const { json: cart } = await api('POST', '/carts');

    const raw = await fetch(`${base}/carts/${cart.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as any).error.code).toBe('INVALID_JSON');

    const wrongType = await api('POST', `/carts/${cart.id}/items`, { productId: 'p-100', quantity: '2' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json.error.code).toBe('INVALID_REQUEST');
  });
});

describe('HTTP API under concurrent requests', () => {
  // These run against a dedicated server so inventory numbers are predictable.
  let server2: ReturnType<typeof createServer>;
  let base2: string;

  beforeAll(async () => {
    server2 = createServer(makeService());
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    base2 = `http://localhost:${(server2.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server2.close();
  });

  async function api2(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await fetch(base2 + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  async function cartWith(productId: string, quantity: number): Promise<string> {
    const { json: cart } = await api2('POST', '/carts');
    await api2('POST', `/carts/${cart.id}/items`, { productId, quantity });
    return cart.id as string;
  }

  test('20 concurrent checkouts for 2 units of stock yield exactly 2 orders', async () => {
    const cartIds = await Promise.all(Array.from({ length: 20 }, () => cartWith('p-104', 1)));

    const results = await Promise.all(
      cartIds.map((id) => api2('POST', `/carts/${id}/checkout`, {})),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(2);
    expect(conflicts).toHaveLength(18);
    for (const c of conflicts) expect(c.json.error.code).toBe('INSUFFICIENT_INVENTORY');

    const { json } = await api2('GET', '/products');
    const limited = json.products.find((p: any) => p.id === 'p-104');
    expect(limited.inventory).toBe(0);
  });

  test('concurrent retries with one idempotency key produce one order', async () => {
    const cartId = await cartWith('p-100', 1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api2('POST', `/carts/${cartId}/checkout`, {}, { 'Idempotency-Key': 'burst-key' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
  });

  test('one coupon, many concurrent redeemers: exactly one wins', async () => {
    // Reach the milestone (2 orders already exist from the oversell test).
    const report0 = await api2('GET', '/admin/report');
    const needed = Math.max(0, 5 - report0.json.totalOrders);
    for (let i = 0; i < needed; i++) {
      const id = await cartWith('p-103', 1);
      expect((await api2('POST', `/carts/${id}/checkout`, {})).status).toBe(201);
    }

    const coupon = await api2('POST', '/admin/coupons');
    expect(coupon.status).toBe(201);

    const cartIds = await Promise.all(Array.from({ length: 8 }, () => cartWith('p-100', 1)));
    const results = await Promise.all(
      cartIds.map((id) => api2('POST', `/carts/${id}/checkout`, { couponCode: coupon.json.code })),
    );

    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const l of lost) expect(l.json.error.code).toBe('COUPON_ALREADY_REDEEMED');
    expect(won[0]!.json.couponCode).toBe(coupon.json.code);
    expect(won[0]!.json.discountCents).toBe(250);

    // The losers' carts are untouched and can still check out without the coupon.
    const loserCart = cartIds.find((id) => id !== won[0]!.json.cartId)!;
    const retry = await api2('POST', `/carts/${loserCart}/checkout`, {});
    expect(retry.status).toBe(201);
    expect(retry.json.discountCents).toBe(0);
  });

  test('report reconciles with orders and coupons after all of the above', async () => {
    const report = await api2('GET', '/admin/report');
    const again = await api2('GET', '/admin/report');
    expect(again.json).toEqual(report.json);
    expect(report.json.couponsGenerated).toBe(1);
    expect(report.json.couponsRedeemed).toBe(1);
    expect(report.json.couponsAvailable).toBe(0);
    expect(report.json.netRevenueCents).toBe(
      report.json.grossRevenueCents - report.json.totalDiscountCents,
    );
    expect(report.json.purchasedQuantityByProduct['p-104']).toBe(2);
  });
});
