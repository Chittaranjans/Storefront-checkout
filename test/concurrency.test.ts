import { describe, expect, test } from 'bun:test';
import { makeService, placeOrders } from './helpers';

describe('concurrency', () => {
  test('concurrent checkouts never oversell inventory', async () => {
    const service = makeService();
    const limited = service.store.products.get('p-104')!;
    expect(limited.inventory).toBe(2);

    const carts = Array.from({ length: 10 }, () => {
      const cart = service.createCart();
      service.addItem(cart.id, 'p-104', 1);
      return cart;
    });

    const results = await Promise.allSettled(
      carts.map((cart) => service.checkout(cart.id, undefined, undefined)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.code).toBe('INSUFFICIENT_INVENTORY');
    }
    expect(limited.inventory).toBe(0);
    expect(service.store.orders.size).toBe(2);
  });

  test('two concurrent checkouts cannot redeem the same coupon', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const carts = Array.from({ length: 5 }, () => {
      const cart = service.createCart();
      service.addItem(cart.id, 'p-100', 1);
      return cart;
    });

    const results = await Promise.allSettled(
      carts.map((cart) => service.checkout(cart.id, coupon.code, undefined)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(coupon.status).toBe('redeemed');

    const ordersWithCoupon = [...service.store.orders.values()].filter(
      (o) => o.couponCode === coupon.code,
    );
    expect(ordersWithCoupon).toHaveLength(1);
  });

  test('concurrent coupon generation creates exactly one coupon per milestone', async () => {
    const service = makeService();
    await placeOrders(service, 5);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.generateCoupon()),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(service.store.coupons.size).toBe(1);
    const codes = results.map((r) => (r as PromiseFulfilledResult<any>).value.code);
    expect(new Set(codes).size).toBe(1);
  });

  test('concurrent checkouts of the same cart create exactly one order', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => service.checkout(cart.id, undefined, `key-${i}`)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(service.store.orders.size).toBe(1);
    expect(service.store.products.get('p-100')!.inventory).toBe(49);
  });

  test('repeated checkout with the same idempotency key is safe under concurrency', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.checkout(cart.id, undefined, 'shared-key')),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = results.map((r) => (r as PromiseFulfilledResult<any>).value.id);
    expect(new Set(ids).size).toBe(1);
    expect(service.store.orders.size).toBe(1);
    expect(service.store.products.get('p-100')!.inventory).toBe(48);
  });
});
