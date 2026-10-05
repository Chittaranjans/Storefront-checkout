export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const Errors = {
  invalidRequest: (message: string) => new AppError(400, 'INVALID_REQUEST', message),
  invalidJson: () => new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON'),
  invalidQuantity: (message = 'Quantity must be a positive integer') =>
    new AppError(400, 'INVALID_QUANTITY', message),
  productNotFound: (id: string) =>
    new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${id} does not exist`, { productId: id }),
  cartNotFound: (id: string) =>
    new AppError(404, 'CART_NOT_FOUND', `Cart ${id} does not exist`, { cartId: id }),
  orderNotFound: (id: string) =>
    new AppError(404, 'ORDER_NOT_FOUND', `Order ${id} does not exist`, { orderId: id }),
  itemNotInCart: (productId: string) =>
    new AppError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in the cart`, { productId }),
  insufficientInventory: (productId: string, requested: number, available: number) =>
    new AppError(
      409,
      'INSUFFICIENT_INVENTORY',
      `Not enough inventory for product ${productId}: requested ${requested}, available ${available}`,
      { productId, requested, available },
    ),
  /**
   * Carries the existing orderId so a client that lost the original response
   * (and did not send an Idempotency-Key) can still recover the order.
   */
  cartAlreadyCheckedOut: (id: string, orderId?: string) =>
    new AppError(
      409,
      'CART_ALREADY_CHECKED_OUT',
      `Cart ${id} has already been checked out`,
      orderId ? { cartId: id, orderId } : { cartId: id },
    ),
  cartEmpty: () => new AppError(400, 'CART_EMPTY', 'Cannot check out an empty cart'),
  couponNotFound: (code: string) =>
    new AppError(404, 'COUPON_NOT_FOUND', `Coupon ${code} does not exist`, { couponCode: code }),
  couponAlreadyRedeemed: (code: string) =>
    new AppError(409, 'COUPON_ALREADY_REDEEMED', `Coupon ${code} has already been redeemed`, {
      couponCode: code,
    }),
  milestoneNotReached: (ordersPlaced: number, nextMilestone: number) =>
    new AppError(
      409,
      'MILESTONE_NOT_REACHED',
      `No eligible order milestone has been reached yet (${ordersPlaced} orders placed, next milestone at ${nextMilestone})`,
      { ordersPlaced, nextMilestone },
    ),
  idempotencyKeyReused: () =>
    new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was already used for a different checkout request',
    ),
};
