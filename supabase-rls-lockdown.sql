-- Optional security hardening after the app is routed through authenticated Next.js APIs.
-- This does not delete app data, snapshots, backups, storage buckets, or storage objects.
-- Run in Supabase SQL Editor only after SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY
-- is configured in the deployed server environment.

alter table public.app_snapshots enable row level security;
alter table public.app_snapshot_backups enable row level security;

drop policy if exists "mvp anon read app snapshots" on public.app_snapshots;
drop policy if exists "mvp anon write app snapshots" on public.app_snapshots;

drop policy if exists "mvp anon read app snapshot backups" on public.app_snapshot_backups;
drop policy if exists "mvp anon insert app snapshot backups" on public.app_snapshot_backups;

-- The bucket remains public so saved screen images can render from public URLs.
-- Anonymous uploads/updates are no longer needed because the app now asks the
-- server for a signed upload URL, then uploads to that signed URL directly.
drop policy if exists "mvp anon upload screen images" on storage.objects;
drop policy if exists "mvp anon update screen images" on storage.objects;

-- Keep public read policy for the public screen image bucket.
drop policy if exists "mvp anon read screen images" on storage.objects;
create policy "mvp anon read screen images"
on storage.objects
for select
to anon
using (bucket_id = 'screen-images');
