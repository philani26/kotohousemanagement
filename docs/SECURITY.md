# Security, backups and recovery

## Security model

| Threat | Control |
|---|---|
| Another shop or a stranger reads your data | Every path is under `businesses/{b}`. Rules require `request.auth.token.businessId == b`. Users without claims can read nothing. |
| Employee makes themselves owner | Roles are custom claims set only by Admin SDK code. `users` and `employees` are not writable from clients. Tested. |
| Employee changes prices or deletes or edits a sale | Products are owner-only and need `updatedBy`/`updatedAt` stamps. Sales have `allow write: if false` for everyone. Tested. |
| Employee hides cash theft by editing the expected balance | Expected cash is computed by `closeShift` and `cashSessions` aren't readable by employees (blind count). Differences need an explanation. |
| Fake totals sent from a modified app | The server prices every sale from Firestore and validates payments, quantities and discounts. |
| Double charging on a flaky connection | Client idempotency key (`saleId`) used as the document id inside a transaction |
| Approving own refund, expense or stock correction | `decideApproval` is owner-only. Employee adjustments always become approvals. |
| Hiding activity | `auditLogs` are written only by functions and are read-only, including for owners. Catalogue edits are logged by triggers. |
| Ex-employee keeps access | `updateEmployee(active:false)` disables the login, revokes refresh tokens, and every function re-checks `employees/{uid}.active` |
| Leaked admin keys | No Admin credentials exist in the web app. Functions use their runtime service account. |
| Malicious uploads | Storage rules: only your own folder, images or PDF only, under 5 MB, no overwrite or delete |

Run the rules tests after any rule change: `npm --prefix functions run test:rules`.

### Also recommended
- Enable **App Check** and enforce it on callables (see DEPLOYMENT.md).
- The owner account should use a strong, unique password. Turn on Google sign-in with 2-step verification if you prefer (enable the provider and add a button).
- Keep `firebase-tools`, `firebase-functions` and `firebase-admin` up to date (`npm outdated`).

## Backups

Your records are financial records. Under SARS rules, keep them for 5 years.

1. **Point-in-time recovery (PITR):** Firestore → Disaster recovery → enable. Recovers any minute of the last 7 days.
2. **Scheduled backups:** Firestore → Disaster recovery → *Create schedule* → daily, retention 14 weeks. Add a weekly schedule kept for 1 year, or more if needed.
3. **Off-platform copy (monthly):** download the month's **Reports › CSV** and keep it with your bookkeeper. For a full export:
   ```bash
   gcloud firestore export gs://<your-backup-bucket>/$(date +%Y-%m)
   ```
   Give the bucket a retention policy so exports can't be deleted early.
4. **Receipts:** Storage objects can be protected with Object Versioning on the bucket.

## Recovery

| Situation | Steps |
|---|---|
| A document was changed or deleted by mistake (should be impossible from the app) | Use PITR: read the document at a past time with `gcloud firestore databases` / the console, or restore the database to a new database id and copy the record back. |
| Whole database lost or corrupted | Firestore → Disaster recovery → restore a backup to a **new** database, check it, then point the app at it (or restore over the default database during off-hours). |
| Owner locked out | Reset the password from the login page. If the account is lost, use the Firebase console → Authentication to reset it. Claims stay attached to the uid. |
| Phone or tablet stolen | Change the passwords of anyone signed in on it (Staff › New password revokes sessions). Nothing is stored on the device beyond a cache. |
| Bad deploy | `firebase hosting:rollback`, or redeploy the previous git commit. |

Test a restore into a separate database at least once a year.
