# Kota House backend (Java + PostgreSQL)

Spring Boot 4 on Java 21 with PostgreSQL 17. This replaces the Firebase Cloud Functions module by module; the plan and its current phase are in [docs/JAVA-MIGRATION.md](../docs/JAVA-MIGRATION.md).

## Run it locally

You need **JDK 21** (if `JAVA_HOME` points to an older JDK, set it for the shell first) and **Docker Desktop**.

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"   # Git Bash, if needed
cd backend
docker compose up -d db          # PostgreSQL on localhost:5432
mvn spring-boot:run              # API on http://localhost:8080; Flyway creates the tables
```

Or run both in Docker: `docker compose --profile app up --build`.

## Tests

```bash
mvn verify      # unit tests + *IT tests that run the whole app against PostgreSQL in Docker
```

## Layout

| Package | What |
|---|---|
| `auth` | Sign-in, sign-up, refresh tokens, password reset, Argon2id and Firebase-scrypt passwords |
| `shop` | Shops (tenants) and `ShopAccess`, the per-request check of the caller's role in a shop |
| `staff` | Staff logins (owner only) |
| `audit` | Append-only activity log |
| `bridge` | One-way mirror into Firebase while modules still run there (removed at switch-off) |
| `resources/db/migration` | Flyway SQL migrations; never edit one that has run in production, add a new one |

## API so far (phase 1)

| | |
|---|---|
| `POST /api/auth/login` `{email, password}` | → access + refresh token, shops, Firebase custom token |
| `POST /api/auth/signup` `{email, password, displayName}` | new owner, no shop yet |
| `POST /api/auth/refresh` `{refreshToken}` | rotates the refresh token |
| `POST /api/auth/logout` `{refreshToken}` | |
| `POST /api/auth/password-reset` `{email}` / `…/confirm` `{token, newPassword}` | |
| `GET /api/me` | the signed-in person and their shops |
| `POST /api/businesses` `{businessName, displayName}` | create a shop (caller becomes owner) |
| `GET/POST /api/businesses/{b}/staff`, `PATCH …/staff/{uid}` | staff logins (owner) |

Errors are `{"code": "...", "message": "..."}` with the same codes the Firebase functions used.

## Configuration (environment variables)

| Variable | |
|---|---|
| `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD` | PostgreSQL |
| `JWT_SECRET` | base64, ≥ 32 random bytes (`openssl rand -base64 32`). **Required outside local dev** |
| `OWNER_EMAILS` | who may create shops (empty = anyone) |
| `CORS_ORIGINS`, `APP_URL` | the app's address |
| `FIREBASE_BRIDGE`, `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | the Firebase mirror while modules still run there |
| `FIREBASE_HASH_SIGNER_KEY`, `…_SALT_SEPARATOR`, `…_ROUNDS`, `…_MEM_COST` | to accept passwords imported from Firebase |
