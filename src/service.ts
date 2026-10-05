import { randomBytes, randomUUID } from 'node:crypto';
import { Errors } from './errors';
import { discountCents } from './money';
import { Mutex, Store } from './store';
import type { Cart, CartView, Coupon, Order, OrderLine, Product, Report } from './types';

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

  checkout(cartId: string, couponCode: string | undefined, idempotencyKey: string | undefined): Promise<Order> {
    return this.mutex.run(() => this.checkoutSync(cartId, couponCode, idempotencyKey));
  }

  getOrder(orderId: string): Order {
    const order = this.store.orders.get(orderId);
    if (!order) throw Errors.orderNotFound(orderId);
    return order;
  }

  // ----------------------------------------------------------------- coupons

  generateCoupon(): Promise<Coupon> {
    return this.mutex.run(() => this.generateCouponSync());
  }

  // ------------------------------------------------------------------ report

  report(): Report {
    const purchasedQuantityByProduct: Record<string, number> = {};
    let grossRevenueCents = 0;
    let totalDiscountCents = 0;

    for (const order of this.store.orders.values()) {
      grossRevenueCents += order.subtotalCents;
      totalDiscountCents += order.discountCents;
      for (const line of order.lines) {
        purchasedQuantityByProduct[line.productId] =
          (purchasedQuantityByProduct[line.productId] ?? 0) + line.quantity;
      }
    }

    let couponsAvailable = 0;
    let couponsRedeemed = 0;
    for (const coupon of this.store.coupons.values()) {
      if (coupon.status === 'available') couponsAvailable += 1;
      else couponsRedeemed += 1;
    }

    return {
      purchasedQuantityByProduct,
      grossRevenueCents,
      totalDiscountCents,
      netRevenueCents: grossRevenueCents - totalDiscountCents,
      couponsGenerated: this.store.coupons.size,
      couponsAvailable,
      couponsRedeemed,
      totalOrders: this.store.orders.size,
    };
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
  private checkoutSync(
    cartId: string,
    couponCode: string | undefined,
    idempotencyKey: string | undefined,
  ): Order {
    // Invariant 3: a retried checkout returns the original order. The key is
    // only recorded after a *successful* checkout, so a failed attempt can be
    // retried with the same key. A key replayed with a different cart or
    // coupon is a client bug, not a retry, and is rejected.
    if (idempotencyKey) {
      const prior = this.store.idempotency.get(idempotencyKey);
      if (prior) {
        if (prior.cartId !== cartId || prior.couponCode !== couponCode) {
          throw Errors.idempotencyKeyReused();
        }
        return this.store.orders.get(prior.orderId)!;
      }
    }

    // Invariant 2: one cart -> at most one order.
    const cart = this.getCartOrThrow(cartId);
    if (cart.checkedOutAt) throw Errors.cartAlreadyCheckedOut(cartId, cart.orderId);
    if (cart.items.length === 0) throw Errors.cartEmpty();

    // Invariant 5: only an available coupon may be used. It is *not* marked
    // redeemed here - only after every other validation passes (invariant 6).
    let coupon: Coupon | undefined;
    if (couponCode) {
      coupon = this.store.coupons.get(couponCode);
      if (!coupon) throw Errors.couponNotFound(couponCode);
      if (coupon.status === 'redeemed') throw Errors.couponAlreadyRedeemed(couponCode);
    }

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

    // Invariant 7: integer cents; discount is floored and clamped (money.ts).
    const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    const discountPercent = coupon?.percent ?? 0;
    const discount = discountCents(subtotalCents, discountPercent);
    const totalCents = subtotalCents - discount;

    // ---- Commit point. Everything below is pure mutation with no further
    // ---- validation, so it either all happens or none of it does.
    const now = new Date().toISOString();
    for (const line of lines) {
      this.store.products.get(line.productId)!.inventory -= line.quantity;
    }

    // Invariant 8: the order snapshots names, prices, and the discount percent.
    const order: Order = {
      id: randomUUID(),
      cartId: cart.id,
      lines,
      subtotalCents,
      discountPercent,
      discountCents: discount,
      totalCents,
      ...(coupon ? { couponCode: coupon.code } : {}),
      createdAt: now,
    };
    this.store.orders.set(order.id, order);
    cart.checkedOutAt = now;
    cart.orderId = order.id;

    if (coupon) {
      coupon.status = 'redeemed';
      coupon.redeemedAt = now;
      coupon.orderId = order.id;
    }

    if (idempotencyKey) {
      this.store.idempotency.set(idempotencyKey, {
        orderId: order.id,
        cartId: cart.id,
        ...(couponCode !== undefined ? { couponCode } : {}),
      });
    }

    return order;
  }

  /**
   * Invariant 4: at most one coupon per milestone. Generates for the oldest
   * reached-but-unrewarded milestone; if all reached milestones are rewarded,
   * returns the latest coupon so the admin call is idempotent.
   */
  private generateCouponSync(): Coupon {
    const { n, x } = this.store.config;
    const orderCount = this.store.orders.size;

    if (orderCount < n) throw Errors.milestoneNotReached(orderCount, n);

    let milestone: number | undefined;
    for (let m = n; m <= orderCount; m += n) {
      if (!this.store.couponByMilestone.has(m)) {
        milestone = m;
        break;
      }
    }

    if (milestone === undefined) {
      const latest = Math.floor(orderCount / n) * n;
      return this.store.coupons.get(this.store.couponByMilestone.get(latest)!)!;
    }

    const code = this.newCouponCode();
    const coupon: Coupon = {
      code,
      percent: x,
      milestone,
      status: 'available',
      createdAt: new Date().toISOString(),
    };
    this.store.coupons.set(code, coupon);
    this.store.couponByMilestone.set(milestone, code);
    return coupon;
  }

  private newCouponCode(): string {
    const { x } = this.store.config;
    let code: string;
    do {
      code = `SAVE${x}-${randomBytes(4).toString('hex').toUpperCase()}`;
    } while (this.store.coupons.has(code));
    return code;
  }
}
