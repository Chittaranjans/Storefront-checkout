/**
 * All money is represented as integer cents. No floating point is ever used.
 *
 * Discount is deterministic: floor(subtotal * percent / 100), clamped so the
 * order total can never become negative even if a misconfigured percent > 100
 * were supplied.
 */
export function discountCents(subtotalCents: number, percent: number): number {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error(`subtotalCents must be a non-negative integer, got ${subtotalCents}`);
  }
  if (percent <= 0) return 0;
  const raw = Math.floor((subtotalCents * percent) / 100);
  return Math.min(raw, subtotalCents);
}
