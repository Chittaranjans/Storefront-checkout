# DECISIONS

Design record for the Storefront Checkout & Rewards service. The README is the
*what*; this document is the *why*.

**Contents**

1. [Invariants](#1-invariants)
2. [Ambiguities and the semantics chosen](#2-ambiguities-and-the-semantics-chosen)
3. [Decision records](#3-decision-records)
4. [Transactions, concurrency, and idempotency](#4-transactions-concurrency-and-idempotency)
5. [Money and rounding](#5-money-and-rounding)
6. [Error model](#6-error-model)
7. [Implemented vs. deferred](#7-implemented-vs-deferred)
8. [Scaling to multiple instances and a real database](#8-scaling-to-multiple-instances-and-a-real-database)
9. [How AI tools were used](#9-how-ai-tools-were-used)
10. [Next two hours](#10-next-two-hours)

---

## 1. Invariants

These must hold regardless of retries, concurrency, or admin mistakes. Each
one is enforced in exactly one place and pinned by at least one test that
would fail if the enforcement were removed.

| # | Invariant | Enforced in | Pinned by |
|---|-----------|-------------|-----------|
| I1 | **Inventory is never oversold.** Total ordered quantity per product never exceeds seeded stock. | `checkoutSync`: validate every line, *then* decrement | `concurrency.test.ts` oversell; `api.test.ts` "20 concurrent checkouts" |
| I2 | **A cart yields at most one order.** | `checkoutSync`: `cart.checkedOutAt` guard | `concurrency.test.ts` "same cart" |
| I3 | **A retried checkout never creates a second order or charges inventory twice.** | `checkoutSync`: idempotency lookup, recorded only on success | `checkout.test.ts` retry tests; `api.test.ts` "concurrent retries" |
| I4 | **At most one coupon per milestone.** | `generateCouponSync`: `couponByMilestone` | `coupon.test.ts`; `concurrency.test.ts` "exactly one coupon per milestone" |
| I5 | **A coupon is redeemed at most once**, never by two concurrent checkouts. | status check inside the mutex-serialised critical section | `concurrency.test.ts`; `api.test.ts` "many concurrent redeemers" |
| I6 | **A failed checkout never consumes a coupon.** | coupon marked `redeemed` only after the commit point | `coupon.test.ts` "failed checkout does not consume" |
| I7 | **Totals are exact integer cents and never negative.** | `money.ts` `discountCents` (floor + clamp) | `money.test.ts` |
| I8 | **An order is an immutable, self-describing snapshot.** | `Order` type: lines copy name/price; `discountPercent` stored | `checkout.test.ts` snapshot tests |
| I9 | **The report reconciles and never mutates state.** | `report()` is a pure read | `report.test.ts`; `api.test.ts` "report reconciles" |

The critical sections in `src/service.ts` carry `// Invariant N` comments at
the exact line each one is enforced.

## 2. Ambiguities and the semantics chosen

| Question | Choice | Reasoning |
|----------|--------|-----------|
| Price changes between add-to-cart and checkout | **Checkout-time price wins.** The order records the price actually used. | The cart is a wish-list, not a price lock. Snapshotting in the order keeps it explainable. A lock-at-add policy would be equally valid but needs expiry rules. |
| Stock changes between add-to-cart and checkout | **Validated only at checkout.** A cart may hold more than is in stock. | An add-time check gives false confidence - stock can change a millisecond later. Checkout is the only authoritative point. |
| Scope of a coupon | **Whole-order percentage**, one coupon per order. | Nothing in the brief suggests per-line or stacked coupons; the single `couponCode` field makes stacking impossible by construction. |
| Which milestone does the admin get? | **Oldest reached-but-unrewarded.** | A lazy admin can never skip a milestone. |
| Repeated / concurrent admin requests | **Idempotent.** If all reached milestones are rewarded, the latest coupon is returned. | "Only if a coupon has not already been generated for that milestone" is satisfied; retries are safe. |
| Does an order that *uses* a coupon count toward the next milestone? | **Yes.** | The brief says "every nth successfully placed order", with no exclusion. |
| Coupon ownership | **Bearer token** - no customer model exists. | Binding to a customer is the first thing to add once authentication exists. |
| Coupon expiry, minimum spend | **None.** | Not specified; inventing them adds surface without adding evidence of correctness. |
| What counts as a "retry"? | Same `Idempotency-Key` **and** same cart **and** same coupon. Anything else is `IDEMPOTENCY_KEY_REUSED`. | A 201 that silently ignores a changed coupon would hide a client bug. |
| Failed checkout with an idempotency key | **Key is not recorded.** The client can fix the cart and retry under the same key. | Burning the key on failure would force clients to mint a new one for every correction. |
| Payment | **Successful checkout == payment success.** No gateway abstraction. | See D5. |

## 3. Decision records

### D1 - In-memory store behind an explicit mutex

**Context.** The brief allows in-memory storage only if it still demonstrates
how invariants survive overlapping requests.

**Options.**
1. SQLite/Postgres with real transactions.
2. In-memory, relying implicitly on Node's single-threaded event loop.
3. In-memory plus an explicit promise-chain mutex around the critical sections.

**Choice.** Option 3. `checkout` and `generateCoupon` are wrapped in one
`Mutex` (`src/store.ts`) and their bodies are **fully synchronous**: every
validation runs before any mutation, and all mutations happen in one
uninterrupted block.

**Why.** A database would look more production-like but hides the invariants
behind SQL and adds setup friction for reviewers. Option 2 is correct today
but fragile - one `await` added inside the block by a future change would
silently break atomicity. The mutex makes serialisation a visible, reviewable
contract and survives a move to a multi-threaded runtime.

**Consequences.** Single-process only (see section 8). One coarse global lock
serialises all checkouts; at this scale that is fine and it is trivially
replaceable with per-resource locks or database row locks.

### D2 - Client-supplied `Idempotency-Key` with request fingerprint

**Context.** A client that times out will retry. The retry must not create a
second order or double-charge inventory.

**Options.**
1. No key; rely on the checked-out flag (retry gets a 409).
2. Server-derived key from cart contents.
3. Client key, stored with the resulting order.
4. Option 3 plus a fingerprint of the request.

**Choice.** Option 4. The record stores `orderId`, `cartId`, and `couponCode`.
A replay with a matching fingerprint returns the original order; a mismatch
returns `409 IDEMPOTENCY_KEY_REUSED`. The record is written **only after a
successful checkout**. For clients that send no key, `CART_ALREADY_CHECKED_OUT`
includes the existing `orderId` so recovery is still possible.

**Why.** Option 1 makes a retry *fail* rather than *succeed*, which is hostile
to a client that merely lost the response. Option 2 cannot distinguish "same
checkout retried" from "new checkout of the same cart". The fingerprint
matters: without it, a replay that now asks for a coupon would get a 201 for
an undiscounted order, hiding a client bug behind a success code.

**Consequences.** Clients must mint one key per logical checkout. Keys live
for the process lifetime here; production would expire them. The fingerprint
is shallow (cart + coupon) by design - cart *contents* are already frozen by
the checked-out flag.

### D3 - Integer cents everywhere

**Context.** Floating-point money drifts (`0.1 + 0.2 != 0.3`).

**Options.**
1. `number` dollars with `toFixed` at the edges.
2. A decimal library.
3. Integer minor units, with the single non-trivial operation isolated.

**Choice.** Option 3. All amounts are integer cents. The only arithmetic
beyond addition is the discount, isolated in `discountCents`:
`min(floor(subtotal * pct / 100), subtotal)`.

**Why.** Integers are exact and dependency-free; the arithmetic here does not
justify a decimal library. Floor is deterministic; the clamp guarantees a
non-negative total even for a misconfigured percent.

**Consequences.** Clients must treat `*Cents` fields as minor units. The
currency is implicitly single; multi-currency would need a currency field and
per-currency minor-unit rules.

### D4 - Coupon generation is oldest-first and idempotent

**Context.** The brief says a coupon is generated "only if the milestone has
been reached and a coupon has not already been generated for that milestone",
but not what a repeated request returns.

**Options.**
1. `409` when the milestone is already rewarded.
2. Return the existing coupon (idempotent success).
3. Always target the *highest* reached milestone.

**Choice.** Oldest unrewarded milestone first; if none is pending, return the
latest coupon (option 2). Before *n* orders exist: `409 MILESTONE_NOT_REACHED`.

**Why.** Oldest-first guarantees no milestone is skipped if the admin is slow.
Idempotent success makes admin retries and concurrent clicks safe, and matches
the "not already generated" wording - a second call must never produce a
second coupon for the same milestone.

**Consequences.** The admin cannot tell "just created" from "already existed"
without comparing codes. Acceptable and documented.

### D5 - No payment abstraction

**Context.** The brief permits treating checkout success as payment success or
introducing a fake gateway.

**Options.**
1. `PaymentGateway` interface with a fake implementation.
2. No abstraction.

**Choice.** Option 2.

**Why.** A fake gateway adds a failure point that none of the evaluated
invariants depend on, plus a "payment captured but order failed" compensation
path with no real behaviour behind it. Every interesting failure mode is
upstream of payment.

**Consequences.** Adding real payments later changes the commit order to
*authorise -> reserve inventory + consume coupon -> capture*, and failure after
reservation needs a compensating release. That is a known, deferred area.

### D6 - Structured errors with stable codes and actionable details

**Context.** "Return errors that are distinguishable and useful to an API
client."

**Options.**
1. HTTP status only.
2. Status + free-text message.
3. Status + stable machine code + message + optional structured details.

**Choice.** Option 3 via a single `AppError` (`src/errors.ts`). `details`
carries what a client needs to *act*: the existing `orderId` on a double
checkout, `requested`/`available` on an oversell, `ordersPlaced`/`nextMilestone`
on a premature coupon request.

**Why.** Clients branch on `code`, not on parsing prose. 409 is reserved for
state conflicts so races and retries are distinguishable from bad input.
Structured details remove the temptation to regex IDs out of messages.

**Consequences.** Codes and `details` shapes are part of the API surface and
must stay stable. Unexpected exceptions map to a generic 500 that never leaks
internals.

### D7 - Coupon rule (n, x) is boot-time environment configuration

**Context.** "Configure the system with values n and x." The rule must be
changeable without a code edit, but a bad value would silently corrupt the
reward ledger.

**Options.**
1. Hard-code `5` / `10`.
2. Admin endpoint to change n and x at runtime.
3. Environment variables, validated once at startup, immutable afterwards.

**Choice.** Option 3 (`src/config.ts`), with the active values exposed
read-only on `GET /health`.

**Why.** Changing *n* at runtime makes milestone arithmetic ambiguous - a
coupon "for order 5" means something different once *n* becomes 3. Freezing
the rule per process keeps milestones well-defined. Fail-fast validation turns
a deployment typo into a startup error instead of a corrupted report. *x* is
capped at 100 here *and* clamped in `discountCents` - defence in depth.

**Consequences.** Changing the rule needs a restart. Orders snapshot
`discountPercent`, so history stays explainable across a config change.

## 4. Transactions, concurrency, and idempotency

```
POST /carts/:id/checkout
  |
  |  [mutex acquired]  ----------------------------------------------
  |   1. idempotency lookup        -> replay returns stored order
  |   2. cart exists, open, non-empty
  |   3. coupon exists and is available        (read only - not consumed yet)
  |   4. every line vs. current inventory      (read only - nothing reserved yet)
  |   5. compute subtotal / discount / total   (pure integer arithmetic)
  |   -------- commit point: no validation below this line --------
  |   6. decrement inventory
  |   7. create order, lock cart
  |   8. mark coupon redeemed
  |   9. record idempotency key
  |  [mutex released]  ----------------------------------------------
  v
201 order
```

- **Atomicity.** Steps 1-9 run synchronously with no `await`, so in a
  single-threaded runtime nothing can interleave. Any throw before step 6
  leaves state untouched.
- **Serialisation.** The mutex guarantees the same even if a future edit
  introduces an `await`.
- **Idempotency.** Checked first, recorded last, fingerprinted (D2).
- **Coupon safety.** Read at step 3, written at step 8 - after every other
  validation - so a failing checkout cannot consume it (I6), and the mutex
  means two concurrent redeemers cannot both pass step 3 (I5).
- **Coupon generation** follows the same shape under the same mutex, so the
  order count it reads is never mid-checkout.

## 5. Money and rounding

- Unit: integer cents. Fields: `priceCents`, `unitPriceCents`,
  `lineTotalCents`, `subtotalCents`, `discountCents`, `totalCents`.
- Line total: `unitPriceCents * quantity`.
- Discount: `floor(subtotalCents * percent / 100)`, then
  `min(discount, subtotalCents)`.
- Total: `subtotalCents - discountCents`, provably `>= 0`.
- No floating-point value is ever produced or consumed in money paths.

## 6. Error model

Summarised in the README's error table. The principles:

- One shape: `{ error: { code, message, details? } }`.
- `code` is stable; `message` is for humans; `details` is for programs.
- `400` = malformed request, `404` = referenced thing does not exist,
  `409` = valid request, conflicting world state.
- Nothing internal (stack traces, file paths) is ever returned.

## 7. Implemented vs. deferred

**Implemented**

- Products, carts (create / view / add / update / remove), checkout, orders.
- Milestone coupons: admin generation, single-use redemption, survival across
  failed checkouts.
- Admin report with full reconciliation.
- Idempotency keys with fingerprinting; concurrency safety; integer cents;
  structured errors; env-driven configuration; health endpoint.
- 53 tests, including races at the service layer and over real HTTP.
- A scripted walkthrough (`bun run demo`) and a use-case explorer UI (`/`)
  that run the same scenarios live.

**Deferred, deliberately**

| Item | Why it was left out |
|------|---------------------|
| Authentication / authorisation | Explicitly out of scope. `/admin/*` is the boundary. |
| Durable persistence | In-memory by design; migration path in section 8. |
| Customer identity, coupon ownership | No customer model; coupons are bearer tokens until auth exists. |
| Coupon expiry, minimum spend, stacking | Unspecified; would be invention. One-coupon-per-order is enforced by the request shape. |
| Idempotency-key expiry | Keys live for the process lifetime. |
| Payment gateway | D5. |
| Product administration | Products are seeded; price-change behaviour is still tested by mutating the store directly. |
| Rate limiting, pagination, logging, OpenAPI file | Orthogonal to the evaluated invariants. README + demo script + UI are the contract. |

## 8. Scaling to multiple instances and a real database

The *shape* of the code - validate everything, then commit everything in one
unit - carries over unchanged. What changes is who provides atomicity.

| Today (single process) | With Postgres and N instances |
|------------------------|-------------------------------|
| Global `Mutex` | Dropped. One database transaction per checkout. |
| Check `inventory >= qty` then `inventory -= qty` | `UPDATE products SET inventory = inventory - $q WHERE id = $id AND inventory >= $q` - zero rows affected means oversell, roll back. Or `SELECT ... FOR UPDATE` on the lines first. |
| Check `coupon.status === 'available'` then set `redeemed` | `UPDATE coupons SET status = 'redeemed', order_id = $o WHERE code = $c AND status = 'available'` - zero rows means another checkout won. |
| `Map` of idempotency keys | Table with a `UNIQUE` key; insert inside the same transaction; on conflict, read and return the stored order. |
| `orders.size` for milestones | A monotonic counter row (or `COUNT(*)` of committed orders) read inside the generation transaction, with `UNIQUE(milestone)` on coupons so two admins cannot both insert for the same milestone. |
| In-memory report scan | Aggregate SQL, optionally on a read replica. |

Locking granularity improves for free: Postgres locks rows, so checkouts for
unrelated products no longer serialise against each other.

## 9. How AI tools were used

AI assistants were used for drafting - initial module skeletons, test
scaffolding, the demo script, and the UI - with every line read, run, and
corrected before being kept. Concrete cases where generated output was
rejected or redirected:

1. **Coupon generation was not idempotent.** The first draft of
   `generateCoupon` threw `MILESTONE_NOT_REACHED` once every reached milestone
   was rewarded. Ten parallel admin calls produced one success and nine
   errors. That contradicts "generated only if not already generated" as a
   *safe* operation, so the behaviour was changed to return the existing
   coupon, and the test was rewritten to assert idempotency (D4).

2. **Idempotency keyed only on `cartId`.** A replay of the same key with a
   *different coupon* returned the earlier, undiscounted order with a 201.
   I judged a success code that hides a client bug worse than a 409 and
   extended the stored record to fingerprint the coupon (D2).

3. **A generated test was wrong, not the code.** While writing the fingerprint
   test, an AI-drafted assertion assumed a fresh store (`orders.size === 1`)
   although the test's own setup had already placed five orders. The
   assertion was fixed; the implementation was not touched.

4. **The UI's scenario runner had a stale baseline.** The milestone use case
   compared `couponsGenerated` against a value read *before* an earlier step
   had legitimately generated a coupon, so it failed on a fresh server and
   passed on a used one - a classic order-dependent test. The baseline read
   was moved next to the action it measures.

5. **Tests asserting on messages.** Early drafts matched error *messages*;
   they were switched to match stable error *codes*, which is what clients
   actually branch on and what "distinguishable errors" means.

Concurrency tests were treated with particular suspicion: a test that passes
only because of the single-threaded event loop proves little. The HTTP-level
suites were added so that the race is between real in-flight requests rather
than between promises inside one test function.

## 10. Next two hours

1. **Property-style fuzzing of the critical section.** Hundreds of randomly
   interleaved checkouts, coupon generations, and admin reads, asserting I1-I9
   after every run - the fastest way to find an ordering nobody wrote a test
   for.
2. **Idempotency-key lifecycle.** Expiry, and defined behaviour if a key
   arrives whose stored order no longer exists.
3. **Compensation under partial failure.** If a payment step is added after
   inventory reservation, define and test the release path for both inventory
   and the coupon.
4. **Report consistency during writes.** A test that reads the report
   *while* checkouts are in flight, pinning the current guarantee that it
   always sees a consistent snapshot.
