import { describe, expect, test } from 'bun:test';
import { expectSyncError, makeService } from './helpers';

describe('carts', () => {
  test('creates an empty cart', () => {
    const service = makeService();
    const cart = service.createCart();
    expect(cart.items).toEqual([]);
    expect(service.getCart(cart.id).subtotalCents).toBe(0);
  });

  test('adds, updates, and removes items with correct totals', () => {
    const service = makeService();
    const cart = service.createCart();

    service.addItem(cart.id, 'p-100', 2); // 2500 each
    service.addItem(cart.id, 'p-101', 1); // 8999
    let view = service.getCart(cart.id);
    expect(view.subtotalCents).toBe(2 * 2500 + 8999);

    service.updateItem(cart.id, 'p-100', 5);
    view = service.getCart(cart.id);
    expect(view.subtotalCents).toBe(5 * 2500 + 8999);

    service.removeItem(cart.id, 'p-101');
    view = service.getCart(cart.id);
    expect(view.items).toHaveLength(1);
    expect(view.subtotalCents).toBe(5 * 2500);
  });

  test('adding the same product twice accumulates quantity', () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    service.addItem(cart.id, 'p-100', 3);
    const view = service.getCart(cart.id);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.quantity).toBe(4);
  });

  test('rejects unknown products', () => {
    const service = makeService();
    const cart = service.createCart();
    expectSyncError(() => service.addItem(cart.id, 'nope', 1), 'PRODUCT_NOT_FOUND');
    expect(service.getCart(cart.id).items).toHaveLength(0);
  });

  test('rejects non-positive or non-integer quantities', () => {
    const service = makeService();
    const cart = service.createCart();
    for (const qty of [0, -1, 1.5, NaN, Infinity]) {
      expectSyncError(() => service.addItem(cart.id, 'p-100', qty), 'INVALID_QUANTITY');
    }
    expect(service.getCart(cart.id).items).toHaveLength(0);
  });

  test('rejects mutation of a checked-out cart', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    await service.checkout(cart.id, undefined, undefined);
    expectSyncError(() => service.addItem(cart.id, 'p-100', 1), 'CART_ALREADY_CHECKED_OUT');
  });
});
