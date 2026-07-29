-- Safe additive setup for the Google Vision OCR monthly usage counter.
-- This does not update or delete app snapshots, screens, text regions, or translations.

create table if not exists public.ocr_usage_monthly (
  month text primary key,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.ocr_usage_monthly enable row level security;

create or replace function public.increment_ocr_usage_monthly(p_month text)
returns table (
  month text,
  request_count integer,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  insert into public.ocr_usage_monthly as usage (month, request_count, updated_at)
  values (p_month, 1, now())
  on conflict (month)
  do update
    set request_count = usage.request_count + 1,
        updated_at = now()
  returning usage.month, usage.request_count, usage.updated_at;
$$;

revoke all on table public.ocr_usage_monthly from anon, authenticated;
revoke all on function public.increment_ocr_usage_monthly(text) from public, anon, authenticated;
grant execute on function public.increment_ocr_usage_monthly(text) to service_role;
