import { describe, expect, test } from 'bun:test';
import { expectError, makeService, placeOrders } from './helpers';

describe('coupons', () => {
  test('cannot generate before the milestone is reached', async () => {
    const service = makeService();
    await placeOrders(service, 4);
    await expectError(service.generateCoupon(), 'MILESTONE_NOT_REACHED');
  });

  test('generates one coupon at the nth order and is idempotent per milestone', async () => {
    const service = makeService();
    await placeOrders(service, 5);

    const coupon = await service.generateCoupon();
    expect(coupon.percent).toBe(10);
    expect(coupon.milestone).toBe(5);
    expect(coupon.status).toBe('available');

    const again = await service.generateCoupon();
    expect(again.code).toBe(coupon.code);
    expect(service.store.coupons.size).toBe(1);
  });

  test('generates for the oldest unrewarded milestone first', async () => {
    const service = makeService();
    await placeOrders(service, 12); // milestones 5 and 10 both reached

    const first = await service.generateCoupon();
    const second = await service.generateCoupon();
    expect(first.milestone).toBe(5);
    expect(second.milestone).toBe(10);
    expect(service.store.coupons.size).toBe(2);

    const third = await service.generateCoupon();
    expect(third.code).toBe(second.code);
    expect(service.store.coupons.size).toBe(2);
  });

  test('a valid coupon applies a deterministic discount at checkout', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2); // 5000 subtotal
    const order = await service.checkout(cart.id, coupon.code, undefined);

    expect(order.discountCents).toBe(500);
    expect(order.totalCents).toBe(4500);
    expect(order.couponCode).toBe(coupon.code);
    expect(coupon.status).toBe('redeemed');
  });

  test('a coupon can only be redeemed once', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const cart1 = service.createCart();
    service.addItem(cart1.id, 'p-100', 1);
    await service.checkout(cart1.id, coupon.code, undefined);

    const cart2 = service.createCart();
    service.addItem(cart2.id, 'p-100', 1);
    await expectError(service.checkout(cart2.id, coupon.code, undefined), 'COUPON_ALREADY_REDEEMED');
  });

  test('a failed checkout does not consume the coupon', async () => {
    const service = makeService();
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const failingCart = service.createCart();
    service.addItem(failingCart.id, 'p-104', 3); // only 2 in stock
    await expectError(
      service.checkout(failingCart.id, coupon.code, undefined),
      'INSUFFICIENT_INVENTORY',
    );
    expect(coupon.status).toBe('available');

    const goodCart = service.createCart();
    service.addItem(goodCart.id, 'p-100', 1);
    const order = await service.checkout(goodCart.id, coupon.code, undefined);
    expect(order.couponCode).toBe(coupon.code);
    expect(coupon.status).toBe('redeemed');
  });

  test('unknown coupon is rejected', async () => {
    const service = makeService();
    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    await expectError(service.checkout(cart.id, 'NOPE', undefined), 'COUPON_NOT_FOUND');
  });
});
