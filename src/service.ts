import { randomUUID } from 'node:crypto';
import { Errors } from './errors';
import { Mutex, Store } from './store';
import type { Cart, CartView, Order, OrderLine, Product } from './types';

export class Service {
  private readonly mutex = new Mutex();

  constructor(readonly store: Store) {}

  // ---------------------------------------------------------------- products

  listProducts(): Product[] {
    return [...this.store.products.values()].map((p) => ({ ...p }));
  }

  // ------------------------------------------------------------------- carts

  createCart(): Cart {
    const cart: Cart = { id: randomUUID(), items: [], createdAt: new Date().toISOString() };
    this.store.carts.set(cart.id, cart);
    return cart;
  }

  getCart(cartId: string): CartView {
    return this.cartView(this.getCartOrThrow(cartId));
  }

  addItem(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.getCartOrThrow(cartId);
    this.assertCartOpen(cart);
    if (!this.store.products.has(productId)) throw Errors.productNotFound(productId);
    const qty = this.validateQuantity(quantity);
    const existing = cart.items.find((i) => i.productId === productId);
    if (existing) existing.quantity += qty;
    else cart.items.push({ productId, quantity: qty });
    return this.cartView(cart);
  }

  updateItem(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.getCartOrThrow(cartId);
    this.assertCartOpen(cart);
    if (!this.store.products.has(productId)) throw Errors.productNotFound(productId);
    const qty = this.validateQuantity(quantity);
    const item = cart.items.find((i) => i.productId === productId);
    if (!item) throw Errors.itemNotInCart(productId);
    item.quantity = qty;
    return this.cartView(cart);
  }

  removeItem(cartId: string, productId: string): CartView {
    const cart = this.getCartOrThrow(cartId);
    this.assertCartOpen(cart);
    const idx = cart.items.findIndex((i) => i.productId === productId);
    if (idx === -1) throw Errors.itemNotInCart(productId);
    cart.items.splice(idx, 1);
    return this.cartView(cart);
  }

  // ---------------------------------------------------------------- checkout

  checkout(cartId: string, idempotencyKey: string | undefined): Promise<Order> {
    return this.mutex.run(() => this.checkoutSync(cartId, idempotencyKey));
  }

  getOrder(orderId: string): Order {
    const order = this.store.orders.get(orderId);
    if (!order) throw Errors.orderNotFound(orderId);
    return order;
  }

  // ---------------------------------------------------------------- private

  private getCartOrThrow(cartId: string): Cart {
    const cart = this.store.carts.get(cartId);
    if (!cart) throw Errors.cartNotFound(cartId);
    return cart;
  }

  private assertCartOpen(cart: Cart): void {
    if (cart.checkedOutAt) throw Errors.cartAlreadyCheckedOut(cart.id, cart.orderId);
  }

  private validateQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity <= 0) throw Errors.invalidQuantity();
    return quantity;
  }

  private cartView(cart: Cart): CartView {
    const items = cart.items.map((item) => {
      const product = this.store.products.get(item.productId)!;
      return {
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * item.quantity,
      };
    });
    const subtotalCents = items.reduce((sum, line) => sum + line.lineTotalCents, 0);
    return { ...cart, items, subtotalCents };
  }

  /**
   * Runs entirely synchronously: every validation happens before any mutation,
   * and all mutations happen in one uninterrupted block. Combined with the
   * mutex, no two checkouts can interleave.
   */
  private checkoutSync(cartId: string, idempotencyKey: string | undefined): Order {
    // Invariant 3: a retried checkout returns the original order. The key is
    // only recorded after a *successful* checkout, so a failed attempt can be
    // retried with the same key.
    if (idempotencyKey) {
      const prior = this.store.idempotency.get(idempotencyKey);
      if (prior) {
        if (prior.cartId !== cartId) throw Errors.idempotencyKeyReused();
        return this.store.orders.get(prior.orderId)!;
      }
    }

    // Invariant 2: one cart -> at most one order.
    const cart = this.getCartOrThrow(cartId);
    if (cart.checkedOutAt) throw Errors.cartAlreadyCheckedOut(cartId, cart.orderId);
    if (cart.items.length === 0) throw Errors.cartEmpty();

    // Invariant 1: validate every line against *current* inventory before
    // decrementing anything, so a partial failure never leaves stock reserved.
    const lines: OrderLine[] = [];
    for (const item of cart.items) {
      const product = this.store.products.get(item.productId);
      if (!product) throw Errors.productNotFound(item.productId);
      if (item.quantity <= 0) throw Errors.invalidQuantity();
      if (product.inventory < item.quantity) {
        throw Errors.insufficientInventory(product.id, item.quantity, product.inventory);
      }
      lines.push({
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * item.quantity,
      });
    }

    const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

    // ---- Commit point. Everything below is pure mutation with no further
    // ---- validation, so it either all happens or none of it does.
    const now = new Date().toISOString();
    for (const line of lines) {
      this.store.products.get(line.productId)!.inventory -= line.quantity;
    }

    // Invariant 8: the order snapshots names and prices.
    const order: Order = {
      id: randomUUID(),
      cartId: cart.id,
      lines,
      subtotalCents,
      discountPercent: 0,
      discountCents: 0,
      totalCents: subtotalCents,
      createdAt: now,
    };
    this.store.orders.set(order.id, order);
    cart.checkedOutAt = now;
    cart.orderId = order.id;

    if (idempotencyKey) {
      this.store.idempotency.set(idempotencyKey, { orderId: order.id, cartId: cart.id });
    }

    return order;
  }
}
