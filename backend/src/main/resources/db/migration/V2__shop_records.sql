-- Shop records (sales, shifts, stock, settings, menu, …).
-- Each record keeps the structure the app already uses (data jsonb); the shop,
-- collection and id are real columns. Every change runs inside a database
-- transaction on the server, as the Cloud Functions' Firestore transactions did.
-- Timestamps inside data are {"__ts": <epoch millis>} so they sort and compare correctly.

create table docs (
  business_id  text not null references businesses (id),
  collection   text not null,
  id           text not null,
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (business_id, collection, id)
);
create index docs_data on docs using gin (data jsonb_path_ops);
-- the hot list queries
create index docs_day on docs (business_id, collection, (data ->> 'dayKey'));
create index docs_status on docs (business_id, collection, (data ->> 'status'));

-- Records outside any shop: WhatsApp number → shop mapping.
create table global_docs (
  collection   text not null,
  id           text not null,
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (collection, id)
);

-- Per-shop extras of a staff member (work-site check, device), shown on the Staff page.
alter table memberships add column profile jsonb not null default '{}';

-- The audit log moves into shop records (collection auditLogs), the shape the app reads.
drop table audit_log;

-- Receipt photos and slips (moves to S3 with the AWS deployment).
create table files (
  path         text primary key,
  business_id  text not null references businesses (id),
  uploaded_by  text not null,
  content_type text not null,
  bytes        bytea not null,
  created_at   timestamptz not null default now()
);
