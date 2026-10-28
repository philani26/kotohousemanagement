# Deployment

> There are separate **dev** and **prod** Firebase projects. Follow these steps once per project, then deploy with `npm run deploy:dev` / `npm run deploy:prod`. See [ENVIRONMENTS.md](ENVIRONMENTS.md).

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project** (e.g. `my-kota-house`).
2. Upgrade to the **Blaze (pay-as-you-go)** plan. Cloud Functions require it. A one-till shop normally stays inside the free quotas. Set a **budget alert** (e.g. R100/month) under Google Cloud Billing.
3. **Authentication** → Sign-in method → enable **Email/Password**.
4. **Firestore** → Create database → **Production mode** → location **africa-south1 (Johannesburg)**.
5. **Storage** → Get started → same location.
6. **Project settings → Your apps → Web app** → register and copy the config.

> The functions region is set in `functions/src/common.ts` (`REGION`) and `src/environments/environment*.ts` (`functionsRegion`). They must match your Firestore location. If africa-south1 isn't offered for Functions in your project, use the nearest available region (e.g. `europe-west1`) in both places.

## 2. Configure the app

- Paste the web config into `src/environments/environment.prod.ts`. This config isn't secret. Access is controlled by security rules. **Never** put service-account or Admin keys in the Angular app.
- In `.firebaserc`, replace `demo-kotahouse` with your project id.
- Optional: limit who can create a business by creating `functions/.env`:
  ```
  OWNER_EMAILS=owner@example.co.za
  ```

## 3. Deploy

```bash
npm install && npm --prefix functions install
firebase login
npm run build                     # production Angular build → dist/kotahouse/browser
firebase deploy                   # hosting, functions, firestore rules + indexes, storage rules
```

Indexes take a few minutes to build after the first deploy. Until then some lists may show an error.

## 4. First use

1. Open `https://<project>.web.app` on the owner's phone → **Create owner account** → name the shop.
2. **Menu & recipes** → *Load example menu* (or add your own). Correct every price and ingredient cost.
3. **Ingredients** → check units, costs and reorder levels. Add suppliers.
4. **Stock › Delivery** → record your current stock as a first delivery (or set opening stock when creating each ingredient).
5. **Staff** → create the cashier's login and give them the password in person.
6. **Settings** → hours, trading days, discount limit, alert thresholds, notification email, CCTV links.
7. On the shop phone or tablet: open the site → browser menu → **Add to Home screen**.

## Recommended hardening

- **App Check** (reCAPTCHA Enterprise) for the web app, then set `enforceAppCheck: true` in `setGlobalOptions` in `functions/src/common.ts`.
- Turn on **email enumeration protection** and **password policy** in Authentication settings.
- Enable **Firestore Point-in-time recovery** and scheduled backups (see SECURITY.md).

## Updating

`git pull && npm run build && firebase deploy`. Deploy only part of it with `--only hosting`, `--only functions` or `--only firestore:rules`.

## Costs (rough guide)

Each sale does about 10 to 15 document writes and 10 reads, plus a few function invocations. At 200 orders a day that's about 90k writes and 6k invocations a month, inside the Blaze free tier (20k writes/day, 2M invocations/month). Storage for receipt photos (shrunk to about 200 KB each) is negligible.
