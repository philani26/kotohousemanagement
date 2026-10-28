# Architecture

## Principles

1. **The browser is not trusted with money.** The client sends *intent* (product ids and quantities, a counted cash amount). Cloud Functions read prices, recipes and balances from Firestore, compute totals, change, cost and stock usage, and write everything in one transaction.
2. **Nothing financial is edited or deleted.** Security rules deny all client writes to sales, cash sessions, stock movements, expenses, approvals, audit logs and stats. Corrections are new records (refunds, adjustments) with a reason, an approver and an audit entry.
3. **Money is integer cents (ZAR).** `4550` means R45,50. Never floats.
4. **One source of business rules.** `functions/src/shared/` holds the models, API contracts and pure domain functions. The Angular app imports the same files through the `@shared/*` path alias, so previews in the UI and the authoritative backend can't drift apart.
5. **Revenue ≠ profit.** Reports show revenue, gross profit (after the recipe cost of ingredients) and operating profit (after expenses and stock losses) separately.

## Folder structure

```
kotahouse/
├─ src/                          Angular app (standalone components, signals, zoneless)
│  ├─ environments/              emulator (dev) and production Firebase config
│  └─ app/
│     ├─ core/                   FirebaseService, AuthService (claims), ApiService (typed callables),
│     │                          BusinessService (paths, settings, open shift), liveQuery signals,
│     │                          guards, toasts, receipt uploads
│     ├─ layout/                 shell with role-aware side nav (desktop) / bottom nav (phone)
│     ├─ shared/                 pipes (zar, ts), Chart.js wrapper, ids
│     └─ features/
│        ├─ auth/                login, first-run business setup
│        ├─ pos/  shift/  sales/  expenses/  stock/          staff screens
│        └─ owner/               dashboard, reports, approvals, cash-ups, menu & recipes,
│                                ingredients & suppliers, staff, activity log, alerts, settings, CCTV
├─ functions/                    Cloud Functions (Node 22, TypeScript, 2nd gen)
│  ├─ src/shared/                models.ts · api.ts · domain.ts · money.ts (+ domain.spec.ts)
│  ├─ src/common.ts              auth/claims check, audit(), notify(), settings, paths
│  ├─ src/effects.ts             shared transactional effects (refund, expense decision, stock change, stats)
│  ├─ src/business.ts            setupBusiness, createEmployee, updateEmployee
│  ├─ src/shifts.ts              openShift, recordPayout, closeShift
│  ├─ src/sales.ts               recordSale, requestRefund, verifyPayment
│  ├─ src/expenses.ts            submitExpense
│  ├─ src/stock.ts               recordPurchase, recordStockMovement
│  ├─ src/approvals.ts           decideApproval
│  ├─ src/triggers.ts            audit log for owner catalogue edits, opening stock ledger entry
│  ├─ src/scheduled.ts           monitorActivity (every 15 min): missing close, no sales, not opened
│  └─ test/                      rules tests and end-to-end integration tests (emulator)
├─ firestore.rules · storage.rules · firestore.indexes.json · firebase.json
└─ docs/
```

## Roles and authentication

Firebase Authentication (email + password). Role and business come from **custom claims** `{ businessId, role }` that only Cloud Functions can set:

- `setupBusiness`: a signed-in user with no claims creates a business and becomes its owner. It can be restricted to known emails with `OWNER_EMAILS` in `functions/.env`.
- `createEmployee` / `updateEmployee`: owner only. Deactivating disables the login, revokes sessions and is checked on every function call.

**Several shops:** an owner can create more shops with `setupBusiness`. The claims then include `biz: { [businessId]: role }` for every shop (`businessId`/`role` remain as the default shop for older accounts). The app keeps the active shop per device and sends it as `businessId` with every callable. `requireCaller` and the security rules (`roleIn(b)`) check the caller's role *in that shop*, so being owner of one branch gives nothing in another. Queued offline sales carry the shop they were rung up in.

Route guards in the app are for convenience. The real enforcement is in the rules and the functions.

## Firestore data model

Everything a business owns lives under `businesses/{businessId}/…`, so rules can scope by the `businessId` claim. Interfaces are in [functions/src/shared/models.ts](../functions/src/shared/models.ts).

| Collection | Written by | Purpose |
|---|---|---|
| `users/{uid}` (top level) | functions | read-only mirror of claims |
| `businesses/{b}` | functions | name, owner, receipt counter |
| `businessSettings/main` | owner | hours, trading days, discount limit, alert thresholds, categories, checklists, notification and CCTV settings |
| `employees/{uid}` | functions | staff profile, role, active flag |
| `products/{id}` | owner | name, category, price (cents), active, sort order |
| `recipes/{productId}` | owner | ingredient quantities per one product sold |
| `ingredients/{id}` | owner (meta) / functions (balance) | unit, cost per unit, reorder level, supplier, **theoretical balance** |
| `suppliers/{id}` | owner | contact details |
| `stockMovements/{id}` | functions | append-only stock ledger: opening, purchase, sale, wastage, staffMeal, complimentary, adjustment |
| `purchases/{id}` | functions | deliveries with lines, total, cash paid from till, invoice photo |
| `sales/{saleId}` | functions | lines, prices, discount, total, recipe cost, payment (cash received/change, reference, verified), status, refund |
| `expenses/{id}` | functions | amount, category, date, receipt, paid-from-till, status, decision |
| `shifts/{id}` | functions | who, when, checklists, closing stock count, notes |
| `cashSessions/{shiftId}` | functions | float and running totals; expected / counted / difference / explanation at close. **Owner-only (blind count).** |
| `approvals/{id}` | functions | refund / expense / stockAdjustment requests and decisions |
| `auditLogs/{id}` | functions | who did what, when, with details. Read-only for owners. |
| `notifications/{id}` | functions | owner alerts; owner may only flip `read` |
| `orders/{saleId}` | staff (status only) | kitchen tickets: items, note, status new → preparing → ready → collected. No prices. Written from the device, so it works offline. |
| `dailyStats/{YYYY-MM-DD}` | functions | counters for fast dashboards: sales by method, orders, COGS, refunds, expenses, wastage, products, hourly |

Day keys use the business time zone (`Africa/Johannesburg`).

## How a sale works

1. The POS creates an idempotency key (`saleId`) when an order starts and keeps it until the server confirms.
2. `recordSale` (one Firestore transaction): checks the open shift belongs to the caller, loads products, recipes and ingredients, prices the cart (`priceCart`), checks the discount limit, validates cash (`settlePayment`), and computes ingredient usage and cost (`ingredientUsage`). It then writes the sale, the stock ledger entries, ingredient balances, cash-session totals, `dailyStats`, the audit entry, and low-stock or discount alerts.
3. If the network drops and the cashier taps again, the same `saleId` returns the existing sale (`duplicate: true`). A sale can never be recorded twice.

## Offline selling

If a sale can't reach the server (no network), the POS keeps it in an on-device outbox (`OutboxService`, localStorage per user) and retries every 20 s and whenever the browser comes back online. Each sale keeps its `saleId`, so a sale that reached the server just before the connection dropped is never doubled.

- The device sends `soldAtMillis`. `recordSale` keeps that time (no more than 5 min in the future and 24 h in the past), marks the sale `offline`, and books it on the day and hour it really happened.
- The device sends `expectedTotalCents`. If prices changed before the sale synced, the server records it at current prices and raises a `priceMismatch` alert.
- A sale the server refuses (for example, the product was deactivated) is held on the device for a person to retry or discard.
- Closing the shift and signing out are blocked while the outbox isn't empty.
- In production a service worker (`ngsw-config.json`) caches the app itself, so it opens with no internet. Firestore's persistent cache serves the menu and open shift.

## Cash reconciliation

```
expected cash = opening float + cash sales − cash refunds − approved cash expenses − cash paid out
```

*Cash paid out* covers payouts (such as a cash drop to the owner) and deliveries paid from the till. Pending till expenses are shown separately. If the owner approves one after the shift has closed, that shift's expected cash and difference are recalculated. The count is blind: employees cannot read `cashSessions`. A non-zero difference needs an explanation, and the expected figure can't be edited.

## Stock

Theoretical balance = opening + purchases − recipe usage − wastage − staff meals/complimentary ± approved adjustments. At close the cashier counts physical stock. Ingredients marked `countDaily` (high-theft items) must be counted or `closeShift` refuses. Each variance becomes a `stockAdjustment` approval for the owner, applied directly if the owner closes. Deliveries update the ingredient cost to a weighted average, so profit tracks real prices.

## Profit (estimated)

```
revenue          = sales after discounts − refunds
gross profit     = revenue − recipe cost of goods sold (refunded sales excluded)
operating profit = gross profit − wastage − staff meals − net stock-count losses − approved operating expenses
```

Stock purchases are inventory, not expenses. They reach profit when the stock is used, so they're never subtracted twice.

## Known trade-offs

- **Single till:** only one shift can be open at a time. Supporting several tills means keying sessions by till and dropping that check in `openShift`.
- The ingredient audit trigger also fires on backend stock updates and exits early. That's a few extra function invocations per sale, well inside the free tier.
- Reports read `dailyStats`, so changing a recipe cost doesn't rewrite the cost of past sales. Each sale keeps the cost at the time it was sold.
- **Discounts:** the cashier may discount up to a configurable percentage. Anything above it is refused rather than queued, because the customer is waiting. Discounts are logged and alert above a threshold.
