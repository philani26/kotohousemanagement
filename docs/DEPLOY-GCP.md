# Deploying to Google Cloud

The Java backend and its database run in the `kotahouse-prod` Google Cloud project, in Johannesburg (`africa-south1`).

| Part | Where |
|---|---|
| Backend API | Cloud Run service `kotahouse-api`: https://kotahouse-api-392148085497.africa-south1.run.app |
| Database | Cloud SQL `kotahouse-db` (PostgreSQL 17, db-f1-micro, daily backups kept 14 days, deletion protection on) |
| Secrets | Secret Manager: `kotahouse-db-password`, `kotahouse-jwt-secret`, `kotahouse-monitor-token` |
| Container images | Artifact Registry `africa-south1-docker.pkg.dev/kotahouse-prod/kotahouse/backend` |
| 15-minute checks | Cloud Scheduler job `kotahouse-monitor` (europe-west1, it only calls the API) |
| Web app (preview) | Firebase Hosting channel `java`: https://kotahouse-prod--java-w3rpj8vf.web.app (expires after 30 days; redeploy to renew) |

**Isolated by design:**
- The live shop at https://kotahouse-prod.web.app still runs on Firebase until the data is imported and you switch over.
- The database can only be reached through the Cloud SQL connector with the backend's service account (`kotahouse-backend`).

## Redeploy the backend

Run from Git Bash, in the repository root.

```bash
TAG=$(git rev-parse --short HEAD)
IMG=africa-south1-docker.pkg.dev/kotahouse-prod/kotahouse/backend:$TAG
docker build -t $IMG backend && docker push $IMG
gcloud run deploy kotahouse-api --image=$IMG --region=africa-south1
```

The service keeps its settings (environment, secrets, Cloud SQL connection, one instance). To change environment variables, use a YAML file with `gcloud run services update kotahouse-api --region=africa-south1 --env-vars-file=…`. On Windows, avoid passing values that contain `&` or commas on the command line.

## Redeploy the web app (preview)

```bash
npm run build:prod
npx firebase hosting:channel:deploy java --project prod --expires 30d
```

## Switching the live shop over (later)

1. Import the Firestore data into PostgreSQL.
2. Add `https://kotahouse-prod.web.app` to `CORS_ORIGINS` and set `APP_URL` to it.
3. Run `npm run deploy:prod`, which publishes the web app only.

## Not yet connected in the cloud

- **Email** (password reset, alerts): currently only written to the log.
- **WhatsApp** (`WHATSAPP_*`): dry-run until its secrets are added. Webhook: `<API>/api/webhooks/whatsapp`.
- **Yoco:** connected per shop in Settings; its webhook is registered automatically.
