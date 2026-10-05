import { expect } from 'bun:test';
import { seedProducts } from '../src/seed';
import { Service } from '../src/service';
import { Store } from '../src/store';

export function makeStore(): Store {
  const store = new Store();
  for (const product of seedProducts) {
    store.products.set(product.id, { ...product });
  }
  return store;
}

export function makeService(): Service {
  return new Service(makeStore());
}

/** Places `count` successful orders using a high-inventory product. */
export async function placeOrders(service: Service, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const cart = service.createCart();
    service.addItem(cart.id, 'p-103', 1);
    await service.checkout(cart.id, undefined, undefined);
  }
}

export async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected error with code ${code}, but the promise resolved`);
}

export function expectSyncError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected error with code ${code}, but nothing was thrown`);
}
