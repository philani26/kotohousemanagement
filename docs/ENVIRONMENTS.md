# Environments

| | **local** | **dev** | **prod** |
|---|---|---|---|
| Purpose | coding on your PC | test online with real phones before go-live | the real shop |
| Firebase | emulators (`demo-kotahouse`) | project `kotahouse-dev` | project `kotahouse-prod` |
| App config | `src/environments/environment.ts` | `environment.dev.ts` | `environment.prod.ts` |
| Functions settings | – | `functions/.env.dev` | `functions/.env.prod` |
| Run / deploy | `npm run emulators` + `npm start` | `npm run start:dev` / `npm run deploy:dev` | `npm run deploy:prod` |
| Banner in the app | purple **LOCAL** | pink **DEV · TEST** | none |

Dev and prod are **separate Firebase projects**. They have different logins, shops, sales and settings, so testing can never touch real money records. The project ids above are suggestions. Firebase ids are global, so you may need e.g. `kotahouse-dev-za`. Whatever you choose, use the same id in `.firebaserc` and the environment file.

## One-time setup (do it for dev, then for prod)

1. **Create the project:** https://console.firebase.google.com → *Add project*. Switch it to the **Blaze** plan (Functions need it) and set a budget alert.
2. **Turn on the services:**
   - Authentication → *Email/Password*
   - Firestore → production mode, location **africa-south1**
   - Storage → same location
3. **Register a web app:** *Project settings → Your apps → Web*. Copy the config values into `environment.dev.ts` or `environment.prod.ts`, replacing every `REPLACE_ME`.
4. **Check `.firebaserc`:** the `dev` and `prod` entries must hold the same project ids as the environment files. The deploy script checks this.
5. **Functions settings:**
   - `functions/.env.dev`: leave `OWNER_EMAILS` empty so testers can create shops.
   - `functions/.env.prod`: list only the real owners' emails.

   Firebase picks up the right file automatically from `--project dev|prod`.
6. **First deploy:** run `npm run deploy:dev`. When dev is tested, run `npm run deploy:prod`.

## Day-to-day

- **New feature:** build it on **local**, then `npm run deploy:dev` and test on the shop phone. Only after that, `npm run deploy:prod`.
- **Deploy safety:** `npm run deploy:prod` refuses to run if the config is missing or doesn't match `.firebaserc`, and asks you to type the project id. That way nobody deploys to the real shop by accident.
- **Partial deploys:** `firebase deploy --project dev --only hosting` (or `functions`, `firestore:rules`).
- **Local app against dev data:** `npm run start:dev` runs the app on your PC against the **dev** project. That's useful to reproduce a tester's problem.
- **Never** run the demo seed script or the tests against dev or prod. They only ever talk to the emulators.

## What is shared

The code, security rules, indexes and functions are the same for all three. Only the Firebase project, the web config and `functions/.env.<alias>` differ.
