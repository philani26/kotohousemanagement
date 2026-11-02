-- Phase 1: logins, shops, memberships (staff) and the audit log.
-- Ids are text so records imported from Firebase keep their ids (uids, shop ids).

create table users (
  id               text primary key,
  email            text not null unique check (email = lower(email)),
  display_name     text not null,
  -- 'argon2id': password_hash is a full Argon2 encoding.
  -- 'firebase-scrypt': imported from Firebase; password_salt holds the base64 salt. Re-hashed on first sign-in.
  password_algo    text not null check (password_algo in ('argon2id', 'firebase-scrypt')),
  password_hash    text not null,
  password_salt    text,
  disabled         boolean not null default false,
  created_at       timestamptz not null default now()
);

create table businesses (
  id               text primary key,
  name             text not null,
  owner_uid        text not null references users (id),
  receipt_counter  bigint not null default 0,
  created_at       timestamptz not null default now()
);

-- A person's role in one shop (the Firestore employees/{uid} document).
create table memberships (
  business_id      text not null references businesses (id),
  user_id          text not null references users (id),
  role             text not null check (role in ('owner', 'employee', 'kitchen')),
  display_name     text not null,
  phone            text,
  active           boolean not null default true,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index memberships_user on memberships (user_id);

-- Rotating refresh tokens; only a SHA-256 of the token is stored.
create table refresh_tokens (
  id               uuid primary key,
  user_id          text not null references users (id),
  token_hash       bytea not null unique,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  replaced_by      uuid,
  created_at       timestamptz not null default now()
);
create index refresh_tokens_user on refresh_tokens (user_id) where revoked_at is null;

create table password_resets (
  token_hash       bytea primary key,
  user_id          text not null references users (id),
  expires_at       timestamptz not null,
  used_at          timestamptz
);

-- Append-only: the app never updates or deletes audit rows.
create table audit_log (
  id               bigserial primary key,
  business_id      text not null references businesses (id),
  actor_uid        text,
  actor_name       text not null,
  actor_role       text,
  action           text not null,
  ref_type         text not null,
  ref_id           text not null,
  details          jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index audit_log_business_time on audit_log (business_id, created_at desc);
