import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { Store } from '../src/store';
import { Service } from '../src/service';
import { seedProducts } from '../src/seed';

describe('coupon configuration', () => {
  test('defaults to n=5, x=10 when env is empty', () => {
    expect(loadConfig({})).toEqual({ n: 5, x: 10 });
  });

  test('reads n and x from the environment', () => {
    expect(loadConfig({ COUPON_EVERY_N_ORDERS: '3', COUPON_PERCENT: '25' })).toEqual({ n: 3, x: 25 });
  });

  test('rejects non-integer, zero, negative, or >100% values', () => {
    expect(() => loadConfig({ COUPON_EVERY_N_ORDERS: '0' })).toThrow();
    expect(() => loadConfig({ COUPON_EVERY_N_ORDERS: '2.5' })).toThrow();
    expect(() => loadConfig({ COUPON_EVERY_N_ORDERS: 'five' })).toThrow();
    expect(() => loadConfig({ COUPON_PERCENT: '-10' })).toThrow();
    expect(() => loadConfig({ COUPON_PERCENT: '101' })).toThrow();
  });

  test('a configured n and x drive milestone and discount', async () => {
    const store = new Store({ n: 2, x: 50 });
    for (const p of seedProducts) store.products.set(p.id, { ...p });
    const service = new Service(store);

    const place = async () => {
      const cart = service.createCart();
      service.addItem(cart.id, 'p-100', 1);
      return service.checkout(cart.id, undefined, undefined);
    };

    await place();
    await expect(service.generateCoupon()).rejects.toMatchObject({ code: 'MILESTONE_NOT_REACHED' });

    await place();
    const coupon = await service.generateCoupon();
    expect(coupon.milestone).toBe(2);
    expect(coupon.percent).toBe(50);

    const cart = service.createCart();
    service.addItem(cart.id, 'p-100', 2); // 5000
    const order = await service.checkout(cart.id, coupon.code, undefined);
    expect(order.discountPercent).toBe(50);
    expect(order.discountCents).toBe(2500);
    expect(order.totalCents).toBe(2500);
  });
});
