# Moving the backend to Java + PostgreSQL

**Target:** Spring Boot (Java 21) and PostgreSQL, on AWS Cape Town (`af-south-1`): RDS PostgreSQL plus the Java app on ECS Fargate. Logins move into Java. Existing data is migrated. The move happens **module by module**, and the Angular app keeps working throughout.

## Ground rules (same as today)

- **The browser is not trusted with money.** The server prices sales, computes change, cost and stock, and writes everything in one database transaction.
- **Money is integer cents** (`bigint`). Nothing financial is updated in place or deleted. Corrections are new rows with a reason, an approver and an audit entry.
- **Every request is scoped to one shop.** The caller's role in that shop is checked on the server. Owners get no access to shops they don't belong to.
- **Business rules stay in one place.** The pure rules in `functions/src/shared/*.ts` are ported to Java with the same unit-test cases, so behaviour can't drift.

## Why some modules must move together

Recording one sale writes the sale, its stock movements, the cash session totals, the daily stats, notifications, the audit log, the loyalty card, the Yoco payment and the kitchen ticket, all in one transaction. Refunds, approvals, expenses and cash-ups touch the same rows. These form the **money core** and move in **one** step. Splitting them across Firestore and PostgreSQL would let totals disagree.

## Phases

| # | Module | Moves | Done when |
|---|---|---|---|
| 0 | **Foundation** | `backend/` Spring Boot app, PostgreSQL schema via Flyway, tests against a real PostgreSQL (Testcontainers), Docker image, local `docker compose` | `mvn verify` green; app starts against local PostgreSQL |
| 1 | **Logins and staff** | Sign-in, tokens, password reset, shops and memberships, staff create/update/deactivate | Staff sign in through Java with their **existing passwords** |
| 2 | **Catalogue and settings** | Products, recipes, ingredients, suppliers, categories, settings | Owner edits go to PostgreSQL |
| 3 | **Money core** | Shifts, cash sessions, sales, split payments, refunds, approvals, expenses, stock, daily stats, notifications, audit log, customers and loyalty, Yoco, order queue | Full trading day runs on Java; the day-flow test suite is ported and green |
| 4 | **Operations** | Devices, work-site check, time clock, WhatsApp, 15-minute alerts job, receipt photos (S3), CCTV settings | Nothing left calling Cloud Functions |
| 5 | **Switch-off** | Final data import, Firebase Hosting → S3/CloudFront (optional), remove Functions and Firestore | Firebase project kept read-only for 90 days, then closed |

### How the app works between phases

- **Logins (phase 1 onwards):** Java signs people in and returns its own token **plus a Firebase custom token** with the same shop and role. The app signs into Firebase with it, so modules still on Firestore keep working unchanged.
- **Moved modules:** PostgreSQL is the source of truth. Until the modules that read them have moved too, Java **mirrors** the data one way into Firestore (e.g. the menu, for sales still on Firestore). Nothing is ever written back from Firestore.
- **Live screens** (order queue, dashboard, Yoco "paid") move from Firestore listeners to **server-sent events** from Java as their module moves.
- **Offline selling** keeps working: queued sales already retry with the same sale id, and the server ignores duplicates. Kitchen tickets join the same outbox.

## Logins

- Passwords are hashed with **Argon2id**.
- **Existing passwords keep working.** Firebase exports each user's password hash, and its modified-scrypt algorithm is public. Java checks the old hash on first sign-in, then re-hashes with Argon2id. This needs the project's *password hash parameters*, found in the Firebase console under Authentication → Users → ⋮.
- **Tokens:**
  - **Access token:** a short-lived JWT, 15 minutes.
  - **Refresh token:** rotating, 30 days, stored hashed and revocable.
  - **Deactivating a worker** revokes all their refresh tokens straight away.
- **Password reset emails** are sent through Amazon SES.

## Data migration

A one-off importer (`backend/tools/firestore-import`) reads every Firestore collection and Firebase Auth user and writes them to PostgreSQL with the same ids. It runs once per phase for that phase's tables, then a final time at switch-off.

- **Checks:** row counts per collection, plus per-day and per-shift money totals, must match exactly before a phase goes live.

## AWS (af-south-1)

- **Database:** RDS PostgreSQL 17, Multi-AZ, encrypted, with automated backups (35 days).
- **App:** ECS Fargate behind an Application Load Balancer (HTTPS, ACM certificate).
- **Secrets:** Secrets Manager holds the database password, JWT key, Yoco and WhatsApp secrets.
- **Email and files:** SES for email, S3 for receipt photos.
- **Monitoring:** CloudWatch logs and alarms.
- **Infrastructure as code:** CDK in `infra/`.
