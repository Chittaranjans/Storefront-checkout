export interface Product {
  id: string;
  name: string;
  priceCents: number;
  inventory: number;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
  createdAt: string;
  checkedOutAt?: string;
  orderId?: string;
}

export interface CartLineView {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface CartView extends Cart {
  items: CartLineView[];
  subtotalCents: number;
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/**
 * An immutable snapshot of what was purchased and how the total was derived.
 * It never references live product or coupon data, so it stays explainable
 * even if prices, names, or the coupon configuration change later.
 */
export interface Order {
  id: string;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  totalCents: number;
  couponCode?: string;
  createdAt: string;
}

/**
 * What a checkout with an Idempotency-Key produced, plus a fingerprint of the
 * request so a key replayed with a different payload can be rejected.
 */
export interface IdempotencyRecord {
  orderId: string;
  cartId: string;
  couponCode?: string;
}

export type CouponStatus = 'available' | 'redeemed';

export interface Coupon {
  code: string;
  percent: number;
  milestone: number;
  status: CouponStatus;
  createdAt: string;
  redeemedAt?: string;
  orderId?: string;
}

export interface Config {
  n: number;
  x: number;
}

export interface Report {
  purchasedQuantityByProduct: Record<string, number>;
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  couponsGenerated: number;
  couponsAvailable: number;
  couponsRedeemed: number;
  totalOrders: number;
}
