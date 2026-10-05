import { describe, expect, test } from 'bun:test';
import { makeService, placeOrders } from './helpers';

describe('report', () => {
  test('reconciles with orders and coupons and does not mutate state', async () => {
    const service = makeService();

    // 5 orders, then generate a coupon and redeem it on a 6th order.
    await placeOrders(service, 5);
    const coupon = await service.generateCoupon();

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2); // 5000 subtotal
    await service.checkout(cart.id, coupon.code, undefined);

    const before = service.report();
    const after = service.report();

    expect(after).toEqual(before);
    expect(after.totalOrders).toBe(6);
    expect(after.purchasedQuantityByProduct['p-103']).toBe(5);
    expect(after.purchasedQuantityByProduct['p-100']).toBe(2);

    expect(after.grossRevenueCents).toBe(5 * 4999 + 2 * 2500);
    expect(after.totalDiscountCents).toBe(500);
    expect(after.netRevenueCents).toBe(after.grossRevenueCents - after.totalDiscountCents);

    expect(after.couponsGenerated).toBe(1);
    expect(after.couponsAvailable).toBe(0);
    expect(after.couponsRedeemed).toBe(1);
  });

  test('counts available and redeemed coupons separately', async () => {
    const service = makeService();
    await placeOrders(service, 10); // milestones 5 and 10

    const first = await service.generateCoupon();
    await service.generateCoupon();

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 1);
    await service.checkout(cart.id, first.code, undefined);

    const report = service.report();
    expect(report.couponsGenerated).toBe(2);
    expect(report.couponsAvailable).toBe(1);
    expect(report.couponsRedeemed).toBe(1);
  });
});
