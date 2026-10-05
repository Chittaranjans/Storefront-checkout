# Storefront Checkout & Rewards Service

A small ecommerce backend that stays correct under pressure: customers build
carts and check out, every *n*-th successful order unlocks an *x*% coupon, and
the whole thing keeps its invariants when requests are **retried**, arrive
**concurrently**, or **compete for the same coupon**.

Built with **TypeScript on Bun**. No runtime dependencies - the HTTP layer is
`node:http`, tests use `bun:test`, the demo UI is one static file.

> The design reasoning (invariants, ambiguities, trade-offs, what was deferred)
> lives in [`DECISIONS.md`](./DECISIONS.md). This file is the operational and
> API reference.

---

## Contents

1. [Quick start](#quick-start)
2. [Configuration](#configuration)
3. [Three ways to exercise the service](#three-ways-to-exercise-the-service)
4. [Seed data](#seed-data)
5. [API reference](#api-reference)
6. [Error contract](#error-contract)
7. [Retry and concurrency semantics at a glance](#retry-and-concurrency-semantics-at-a-glance)
8. [Project layout](#project-layout)

---

## Quick start

Requires [Bun](https://bun.sh) 1.1 or newer.

```sh
bun install          # dev-only: typescript + @types/bun
bun run start        # http://localhost:3000
```

```sh
bun test             # 53 tests across 8 files
bun run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
```

The server is in-memory. Restart it to reseed inventory.

## Configuration

Everything is read from the environment at startup. Invalid values abort the
process rather than running with a broken reward rule.

| Variable                | Default | Meaning                                                           |
|-------------------------|---------|-------------------------------------------------------------------|
| `PORT`                  | `3000`  | HTTP port                                                         |
| `COUPON_EVERY_N_ORDERS` | `5`     | **n** - every n-th successful order unlocks one coupon (integer >= 1) |
| `COUPON_PERCENT`        | `10`    | **x** - the coupon's discount percent (integer 1..100)             |

```sh
COUPON_EVERY_N_ORDERS=3 COUPON_PERCENT=25 bun run start
```

The active values are exposed on `GET /health`.

## Three ways to exercise the service

| Method | Command / URL | What you get |
|--------|---------------|--------------|
| **Automated tests** | `bun test` | Business rules, failure modes, and concurrency - at the service layer *and* over real HTTP |
| **Scripted walkthrough** | `bun run demo` (server must be running) | Every endpoint called in order with request/response printed; asserts retry, oversell, and coupon-race behaviour |
| **Use-case explorer UI** | open `http://localhost:3000/` | Eight use-case pages that run live against the server and show each step's requests, status codes, and pass/fail checks; plus a storefront for manual play |

The UI pages map one-to-one onto the risks the service is designed around:

| # | Use case | Demonstrates |
|---|----------|--------------|
| 1 | Cart validation | invalid product / quantity never enters a cart; distinct error codes |
| 2 | Checkout creates an immutable order | price snapshot, exact inventory decrement, cart locks and reports its `orderId` |
| 3 | Retried checkout is idempotent | 5 simultaneous requests sharing one `Idempotency-Key` -> one order |
| 4 | Concurrent checkouts never oversell | N+6 racers for N units -> exactly N orders, stock ends at 0 |
| 5 | Coupon milestones & admin generation | 409 before the milestone; one coupon per milestone; idempotent, race-safe |
| 6 | A coupon is redeemed exactly once | survives a failed checkout; exact floor-based discount; second use -> 409 |
| 7 | Concurrent redeemers of one coupon | 8 racers -> 1 winner; losers can still pay full price |
| 8 | Report reconciles and is read-only | identical on repeat; a known order shifts every figure by the expected delta |

"Run all use cases" is safe to repeat: scenarios choose products from whatever
stock remains.

## Seed data

Six products are loaded at startup (`src/seed.ts`). One has deliberately tiny
inventory so oversell races are easy to provoke.

| id      | name                     | price (cents) | inventory |
|---------|--------------------------|--------------:|----------:|
| `p-100` | Wireless Mouse           |          2500 |        50 |
| `p-101` | Mechanical Keyboard      |          8999 |        30 |
| `p-102` | 27-inch 4K Monitor       |         39999 |        10 |
| `p-103` | USB-C Hub                |          4999 |       100 |
| `p-104` | Limited Edition Desk Mat |          3500 |     **2** |
| `p-105` | HD Webcam                |          5999 |        25 |

## API reference

Conventions:

- All money is **integer cents** (`priceCents`, `subtotalCents`, ...). No floats anywhere.
- Request and response bodies are JSON.
- Administrative operations live under `/admin/*`. No authentication is implemented; the prefix is the boundary.

### Endpoint index

| Method   | Path                            | Role   | Purpose                                            |
|----------|---------------------------------|--------|----------------------------------------------------|
| `GET`    | `/`                             | public | Use-case explorer UI                               |
| `GET`    | `/health`                       | public | Liveness + active coupon config                    |
| `GET`    | `/products`                     | public | Products with current price and inventory          |
| `POST`   | `/carts`                        | public | Create an empty cart                               |
| `GET`    | `/carts/:cartId`                | public | Cart with per-line prices and subtotal             |
| `POST`   | `/carts/:cartId/items`          | public | Add an item (accumulates if already present)       |
| `PATCH`  | `/carts/:cartId/items/:productId` | public | Replace an item's quantity                       |
| `DELETE` | `/carts/:cartId/items/:productId` | public | Remove an item                                   |
| `POST`   | `/carts/:cartId/checkout`       | public | Check out; optional coupon; optional idempotency key |
| `GET`    | `/orders/:orderId`              | public | Retrieve an order snapshot                         |
| `POST`   | `/admin/coupons`                | admin  | Generate a coupon for an eligible milestone        |
| `GET`    | `/admin/report`                 | admin  | Sales and coupon summary (read-only)               |

### Carts

**`POST /carts` -> `201`**

```json
{ "id": "6f1c...", "items": [], "createdAt": "2026-10-05T07:11:04.938Z" }
```

**`GET /carts/:cartId` -> `200`**

Prices shown are the product's *current* prices; the authoritative price is
captured at checkout.

```json
{
  "id": "6f1c...", "createdAt": "...",
  "items": [
    { "productId": "p-100", "name": "Wireless Mouse", "quantity": 2,
      "unitPriceCents": 2500, "lineTotalCents": 5000 }
  ],
  "subtotalCents": 5000
}
```

After checkout the view also carries `checkedOutAt` and `orderId`.

Errors: `404 CART_NOT_FOUND`

**`POST /carts/:cartId/items` -> `200`** - body `{ "productId": "p-100", "quantity": 2 }`
Returns the updated cart view.
Errors: `400 INVALID_REQUEST`, `400 INVALID_QUANTITY`, `404 CART_NOT_FOUND`,
`404 PRODUCT_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`

**`PATCH /carts/:cartId/items/:productId` -> `200`** - body `{ "quantity": 5 }`
Errors: as above plus `404 ITEM_NOT_IN_CART`

**`DELETE /carts/:cartId/items/:productId` -> `200`**
Errors: `404 CART_NOT_FOUND`, `404 ITEM_NOT_IN_CART`, `409 CART_ALREADY_CHECKED_OUT`

### Checkout and orders

**`POST /carts/:cartId/checkout` -> `201`**

| Part   | Field / header            | Required | Notes                                       |
|--------|---------------------------|----------|---------------------------------------------|
| body   | `couponCode`              | no       | an *available* coupon code                  |
| header | `Idempotency-Key`         | no       | opaque string; **strongly recommended**     |

Validates the cart against current inventory, reserves stock, consumes the
coupon (if any), and creates the order - all as one atomic step.

```json
{
  "id": "c9ab...", "cartId": "6f1c...",
  "lines": [
    { "productId": "p-100", "name": "Wireless Mouse", "quantity": 2,
      "unitPriceCents": 2500, "lineTotalCents": 5000 }
  ],
  "subtotalCents": 5000,
  "discountPercent": 10,
  "discountCents": 500,
  "totalCents": 4500,
  "couponCode": "SAVE10-3AE26A87",
  "createdAt": "2026-10-05T07:11:04.957Z"
}
```

The order is a **self-contained snapshot**: product names, unit prices, and
the discount percent are copied in, so it remains explainable after product
data or coupon configuration changes.

Errors: `400 CART_EMPTY`, `404 CART_NOT_FOUND`, `404 COUPON_NOT_FOUND`,
`409 CART_ALREADY_CHECKED_OUT`, `409 INSUFFICIENT_INVENTORY`,
`409 COUPON_ALREADY_REDEEMED`, `409 IDEMPOTENCY_KEY_REUSED`

**`GET /orders/:orderId` -> `200`** - the same snapshot.
Errors: `404 ORDER_NOT_FOUND`

### Administration

**`POST /admin/coupons` -> `201`**

Generates one coupon for the **oldest reached-but-unrewarded** milestone.
If every reached milestone already has a coupon, the most recent coupon is
returned unchanged (idempotent).

```json
{ "code": "SAVE10-3AE26A87", "percent": 10, "milestone": 5,
  "status": "available", "createdAt": "..." }
```

Errors: `409 MILESTONE_NOT_REACHED` (details: `ordersPlaced`, `nextMilestone`)

**`GET /admin/report` -> `200`**

```json
{
  "purchasedQuantityByProduct": { "p-100": 7, "p-104": 2 },
  "grossRevenueCents": 29498,
  "totalDiscountCents": 500,
  "netRevenueCents": 28998,
  "couponsGenerated": 1,
  "couponsAvailable": 0,
  "couponsRedeemed": 1,
  "totalOrders": 6
}
```

Pure read. `netRevenueCents == grossRevenueCents - totalDiscountCents` and
`couponsGenerated == couponsAvailable + couponsRedeemed` always hold.

## Error contract

Every error has the same shape. `code` is stable and meant for branching;
`details` is optional structured context so clients never have to parse
`message`.

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Not enough inventory for product p-104: requested 3, available 2",
    "details": { "productId": "p-104", "requested": 3, "available": 2 }
  }
}
```

| HTTP | `code`                     | When                                                    | `details`                        |
|-----:|----------------------------|---------------------------------------------------------|----------------------------------|
|  400 | `INVALID_REQUEST`          | field missing or wrong type                             | -                                |
|  400 | `INVALID_JSON`             | body is not JSON                                        | -                                |
|  400 | `INVALID_QUANTITY`         | quantity is not a positive integer                      | -                                |
|  400 | `CART_EMPTY`               | checkout of an empty cart                               | -                                |
|  404 | `NOT_FOUND`                | unknown route                                           | -                                |
|  404 | `PRODUCT_NOT_FOUND`        | unknown product id                                      | `productId`                      |
|  404 | `CART_NOT_FOUND`           | unknown cart id                                         | `cartId`                         |
|  404 | `ORDER_NOT_FOUND`          | unknown order id                                        | `orderId`                        |
|  404 | `ITEM_NOT_IN_CART`         | update/remove of a product not in the cart              | `productId`                      |
|  404 | `COUPON_NOT_FOUND`         | unknown coupon code                                     | `couponCode`                     |
|  409 | `INSUFFICIENT_INVENTORY`   | a line asks for more than is in stock                   | `productId`, `requested`, `available` |
|  409 | `CART_ALREADY_CHECKED_OUT` | cart already produced an order                          | `cartId`, `orderId`              |
|  409 | `COUPON_ALREADY_REDEEMED`  | coupon was consumed by an earlier order                 | `couponCode`                     |
|  409 | `MILESTONE_NOT_REACHED`    | fewer than *n* orders exist                             | `ordersPlaced`, `nextMilestone`  |
|  409 | `IDEMPOTENCY_KEY_REUSED`   | key replayed with a different cart or coupon            | -                                |
|  500 | `INTERNAL_ERROR`           | unexpected failure; internals are never leaked          | -                                |

`4xx` vs `409` is deliberate: 400/404 mean *the request is wrong*, 409 means
*the request was fine but the world disagrees* (a race, a retry, a conflict).

## Retry and concurrency semantics at a glance

| Situation | Outcome |
|-----------|---------|
| Same `Idempotency-Key`, same cart, same coupon - sequential or simultaneous | `201`, the **same** order every time; inventory charged once |
| Same key, different cart **or** different coupon | `409 IDEMPOTENCY_KEY_REUSED` - that is a client bug, not a retry |
| Checkout fails (e.g. inventory), then retried with the same key | the key was never recorded, so the retry is evaluated fresh |
| No key, cart already checked out | `409 CART_ALREADY_CHECKED_OUT` with `details.orderId` so the client can recover |
| Many carts race for the last units | exactly `available` orders succeed; the rest get `409 INSUFFICIENT_INVENTORY`; stock never negative |
| Many carts race for one coupon | exactly one succeeds; the rest get `409 COUPON_ALREADY_REDEEMED`; losers' carts stay open |
| Checkout with coupon fails for any reason | coupon stays `available` |
| Admin generates repeatedly / concurrently | one coupon per milestone, same code returned |

## Project layout

```
src/
  index.ts      entrypoint: load config, seed store, listen
  config.ts     COUPON_EVERY_N_ORDERS / COUPON_PERCENT with fail-fast validation
  types.ts      domain model; Order is an immutable snapshot
  money.ts      integer-cents discount: floor(subtotal * pct / 100), clamped
  errors.ts     AppError + the catalogue of stable error codes
  store.ts      in-memory tables + promise-chain Mutex
  service.ts    all business rules; checkoutSync / generateCouponSync are the
                critical sections where every invariant is enforced
  server.ts     thin node:http router, JSON parsing, static UI
  seed.ts       six products, one with inventory 2
test/
  cart / checkout / coupon / report / money / config   business rules
  concurrency.test.ts   racing promises at the service layer
  api.test.ts           real HTTP incl. concurrent in-flight requests
scripts/demo.ts         scripted walkthrough with assertions
public/index.html       use-case explorer UI (served at /)
DECISIONS.md            invariants, ambiguities, decisions, deferrals
```
