-- Run this in Supabase SQL Editor before using cloud persistence.
-- MVP mode: no auth required. owner_id is nullable so Auth/RLS can be added later.

create table if not exists public.app_snapshots (
  id text primary key,
  owner_id uuid null,
  app_state jsonb not null default '{}'::jsonb,
  translations jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_snapshot_backups (
  id text primary key,
  snapshot_id text not null,
  owner_id uuid null,
  app_state jsonb not null default '{}'::jsonb,
  translations jsonb not null default '[]'::jsonb,
  snapshot_updated_at timestamptz null,
  reason text not null default 'auto_before_save',
  created_at timestamptz not null default now()
);

create index if not exists app_snapshot_backups_snapshot_created_idx
on public.app_snapshot_backups (snapshot_id, created_at desc);

alter table public.app_snapshots enable row level security;
alter table public.app_snapshot_backups enable row level security;

drop policy if exists "mvp anon read app snapshots" on public.app_snapshots;
create policy "mvp anon read app snapshots"
on public.app_snapshots
for select
to anon
using (true);

drop policy if exists "mvp anon write app snapshots" on public.app_snapshots;
create policy "mvp anon write app snapshots"
on public.app_snapshots
for all
to anon
using (true)
with check (true);

drop policy if exists "mvp anon read app snapshot backups" on public.app_snapshot_backups;
create policy "mvp anon read app snapshot backups"
on public.app_snapshot_backups
for select
to anon
using (true);

drop policy if exists "mvp anon insert app snapshot backups" on public.app_snapshot_backups;
create policy "mvp anon insert app snapshot backups"
on public.app_snapshot_backups
for insert
to anon
with check (true);

insert into storage.buckets (id, name, public)
values ('screen-images', 'screen-images', true)
on conflict (id) do update set public = true;

drop policy if exists "mvp anon read screen images" on storage.objects;
create policy "mvp anon read screen images"
on storage.objects
for select
to anon
using (bucket_id = 'screen-images');

drop policy if exists "mvp anon upload screen images" on storage.objects;
create policy "mvp anon upload screen images"
on storage.objects
for insert
to anon
with check (bucket_id = 'screen-images');

drop policy if exists "mvp anon update screen images" on storage.objects;
create policy "mvp anon update screen images"
on storage.objects
for update
to anon
using (bucket_id = 'screen-images')
with check (bucket_id = 'screen-images');
