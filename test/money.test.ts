import { describe, expect, test } from 'bun:test';
import { discountCents } from '../src/money';

describe('discountCents', () => {
  test('zero or negative percent gives zero discount', () => {
    expect(discountCents(10000, 0)).toBe(0);
    expect(discountCents(10000, -5)).toBe(0);
  });

  test('10% of 2500 is 250', () => {
    expect(discountCents(2500, 10)).toBe(250);
  });

  test('rounds down deterministically (floor)', () => {
    expect(discountCents(999, 10)).toBe(99);
    expect(discountCents(1001, 10)).toBe(100);
    expect(discountCents(3333, 33)).toBe(1099);
  });

  test('is clamped so total can never go negative', () => {
    expect(discountCents(1000, 100)).toBe(1000);
    expect(discountCents(1000, 150)).toBe(1000);
    expect(discountCents(1000, 1000)).toBe(1000);
  });

  test('total is never negative for any percent', () => {
    const subtotal = 12345;
    for (const percent of [0, 1, 5, 10, 33, 50, 99, 100, 101, 200, 9999]) {
      expect(subtotal - discountCents(subtotal, percent)).toBeGreaterThanOrEqual(0);
    }
  });
});
