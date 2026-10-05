import { describe, expect, test } from 'bun:test';
import type { AppError } from '../src/errors';
import { expectError, makeService, placeOrders } from './helpers';

describe('checkout', () => {
  test('creates an order, decrements inventory, and snapshots prices', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2);
    service.addItem(cart.id, 'p-101', 1);

    const order = await service.checkout(cart.id, undefined, undefined);

    expect(order.subtotalCents).toBe(2 * 2500 + 8999);
    expect(order.discountCents).toBe(0);
    expect(order.totalCents).toBe(order.subtotalCents);
    expect(order.lines).toHaveLength(2);
    expect(service.getOrder(order.id).id).toBe(order.id);

    expect(service.store.products.get('p-100')!.inventory).toBe(48);
    expect(service.store.products.get('p-101')!.inventory).toBe(29);
  });

  test('refuses to oversell limited inventory', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-104', 3); // only 2 in stock
    await expectError(service.checkout(cart.id, undefined, undefined), 'INSUFFICIENT_INVENTORY');
    expect(service.store.products.get('p-104')!.inventory).toBe(2);
  });

  test('refuses an empty cart', async () => {
    const service = makeService();
    const cart = service.createCart();
    await expectError(service.checkout(cart.id, undefined, undefined), 'CART_EMPTY');
  });

  test('refuses a cart that was already checked out', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    await service.checkout(cart.id, undefined, undefined);
    await expectError(service.checkout(cart.id, undefined, undefined), 'CART_ALREADY_CHECKED_OUT');
  });

  test('uses the price at checkout time and the order keeps a snapshot', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1); // 2500 at add time

    service.store.products.get('p-100')!.priceCents = 3000;
    const order = await service.checkout(cart.id, undefined, undefined);
    expect(order.lines[0]!.unitPriceCents).toBe(3000);
    expect(order.totalCents).toBe(3000);

    service.store.products.get('p-100')!.priceCents = 1000;
    expect(service.getOrder(order.id).totalCents).toBe(3000);
  });

  test('retry with the same idempotency key returns the same order', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2);

    const first = await service.checkout(cart.id, undefined, 'key-1');
    const second = await service.checkout(cart.id, undefined, 'key-1');

    expect(second.id).toBe(first.id);
    expect(service.store.orders.size).toBe(1);
    expect(service.store.products.get('p-100')!.inventory).toBe(48);
  });

  test('rejects an idempotency key reused for a different cart', async () => {
    const service = makeService();
    const cartA = service.createCart();
    const cartB = service.createCart();
    service.addItem(cartA.id, 'p-100', 1);
    service.addItem(cartB.id, 'p-100', 1);

    await service.checkout(cartA.id, undefined, 'key-1');
    await expectError(service.checkout(cartB.id, undefined, 'key-1'), 'IDEMPOTENCY_KEY_REUSED');
  });

  test('rejects an idempotency key replayed with a different coupon', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    const order = await service.checkout(cart.id, undefined, 'key-1');

    // Same key, same cart, but now asking for a coupon: not a retry.
    await expectError(service.checkout(cart.id, coupon.code, 'key-1'), 'IDEMPOTENCY_KEY_REUSED');
    expect(coupon.status).toBe('available');
    expect(service.store.orders.size).toBe(6); // 5 setup orders + 1, no new order
    expect(service.getOrder(order.id).discountCents).toBe(0);
  });

  test('a failed checkout does not burn its idempotency key', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-104', 3); // only 2 in stock

    await expectError(service.checkout(cart.id, undefined, 'key-1'), 'INSUFFICIENT_INVENTORY');

    // Client fixes the cart and retries with the same key: must succeed.
    service.updateItem(cart.id, 'p-104', 2);
    const order = await service.checkout(cart.id, undefined, 'key-1');
    expect(order.lines[0]!.quantity).toBe(2);
    expect(service.store.products.get('p-104')!.inventory).toBe(0);
  });

  test('double checkout without a key reports the existing orderId', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    const order = await service.checkout(cart.id, undefined, undefined);

    try {
      await service.checkout(cart.id, undefined, undefined);
      throw new Error('expected CART_ALREADY_CHECKED_OUT');
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe('CART_ALREADY_CHECKED_OUT');
      expect(e.details).toEqual({ cartId: cart.id, orderId: order.id });
    }
  });

  test('insufficient inventory error says what was requested vs available', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-104', 5);

    try {
      await service.checkout(cart.id, undefined, undefined);
      throw new Error('expected INSUFFICIENT_INVENTORY');
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe('INSUFFICIENT_INVENTORY');
      expect(e.details).toEqual({ productId: 'p-104', requested: 5, available: 2 });
    }
  });

  test('order snapshot records the discount percent used', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    const order = await service.checkout(cart.id, coupon.code, undefined);
    expect(order.discountPercent).toBe(10);

    const plain = service.createCart();
    service.addItem(plain.id, 'p-100', 1);
    const plainOrder = await service.checkout(plain.id, undefined, undefined);
    expect(plainOrder.discountPercent).toBe(0);
    expect(plainOrder.couponCode).toBeUndefined();
  });
});
