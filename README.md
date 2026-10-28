# Kota House Management System

A mobile-first point of sale, stock, cash and remote-monitoring system for a South African kota takeaway, built with **Angular 21 + Firebase** (Auth, Firestore, Cloud Functions, Storage, Hosting).

The owner sees sales, cash, stock, expenses and staff activity live from a phone. The cashier gets a fast POS with large buttons. Every money and stock change goes through trusted backend code and is audit-logged.

| | |
|---|---|
| **Cashier** | Open/close shift with float and checklist · sell (cash/card/EFT, change calculated), **also offline** · print/WhatsApp receipts · request refunds · submit expenses with receipt photos · record deliveries, wastage, staff meals · blind cash-up with denomination counter · closing stock count |
| **Owner** | Live dashboard (revenue vs gross vs operating profit, till balance, low stock, best sellers) · approvals (refunds, expenses, stock corrections) · cash-up reconciliation · reports with CSV/print · menu, recipes, ingredient costs · reorder lists to suppliers on WhatsApp · required counts for high-theft items · staff logins · alerts · activity log · CCTV links · settings & thresholds |

## Quick start (local, no cloud account needed)

Requirements: Node 22, Java 21+ (for the Firestore emulator), Firebase CLI (`npm i -g firebase-tools`).

```bash
npm install                     # app (if npm 10 fails with "edgesOut", use: npx npm@11 install)
npm --prefix functions install  # backend
npm run build:functions
npm run emulators               # terminal 1 – Auth, Firestore, Functions, Storage on localhost
npm start                       # terminal 2 – http://localhost:4200
```

**Quickest on Windows:** `npm run local` opens the emulators and the app in two windows.

The development build talks to the emulators only (`src/environments/environment.ts`). Open http://localhost:4200, choose **Create owner account**, set up the shop, then **Menu › Load example menu** to get started.

Or fill the emulators with a demo shop and a morning of trading: `node functions/scripts/seed-demo.mjs`. It creates the logins `owner@demo.co.za` / `owner-pass-123` and `cashier@demo.co.za` / `cashier-pass-123`.

> Emulator data (accounts, shop, sales) is saved to `emulator-data/` when you stop the emulators with Ctrl+C, and loaded again next time.
>
> On Windows the Functions emulator can need longer than 10 s to load: set `FUNCTIONS_DISCOVERY_TIMEOUT=60` before starting the emulators.

## Tests

| Command | What it covers |
|---|---|
| `npm run test:domain` | Pure business rules: pricing, change, recipe usage, cash reconciliation, stock variance, profit, time zone, offline sale times, reorder quantities (28 tests) |
| `npm --prefix functions run test:rules` | Firestore security rules on the emulator: tenancy, blind count, immutable sales/audit, no self-promotion, price/stock protection (12 tests) |
| `npm --prefix functions run test:integration` | Full trading day through the real Cloud Functions: sales, idempotent retry, refunds, expenses, deliveries, wastage, payouts, blind cash-up, offline sales, required closing counts, stats, audit, deactivation (15 tests) |
| `npm test` | Angular unit tests: offline outbox, sign-out rules (10 tests) |

The emulator test suites use their own ports (`firebase.test.json`), so they can run while your dev emulators are up.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – structure, data model, how money and stock flow
- [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) – local, dev and prod: setup, deploying, safety checks
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) – create the Firebase project and go live
- [docs/OPERATING-GUIDE.md](docs/OPERATING-GUIDE.md) – daily routine for the cashier and the owner
- [docs/SECURITY.md](docs/SECURITY.md) – security model, backups and recovery
- [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) – alerts, email and WhatsApp
- [docs/CCTV.md](docs/CCTV.md) – camera setup and secure remote viewing
