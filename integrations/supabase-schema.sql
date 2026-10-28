-- DetailScales onboarding: run once in Supabase, SQL Editor > New query > Run.
--
-- Tables and buckets are private. Row level security is on with no
-- policies, so the public anon key can read and write nothing. Only the
-- Vercel functions, holding the service_role key, can touch this data.

-- ---------- answers from step 2 ----------
create table if not exists public.onboarding_responses (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  client_key       text not null,          -- lower-cased email, links all three submissions
  client_id        text,                   -- browser id, in case the email changes
  business_name    text not null,
  owner_name       text,
  email            text not null,
  phone            text,
  answers          jsonb not null,         -- [{id, section, label, value}, ...] in form order
  delivery_errors  jsonb                   -- set only if Slack or Sheets failed
);

-- ---------- voice recording from step 3 ----------
create table if not exists public.voice_recordings (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  client_key       text not null,
  client_id        text,
  business_name    text not null,
  owner_name       text,
  email            text not null,
  storage_path     text not null,          -- path inside the "voice" bucket
  mime_type        text,
  duration_seconds integer,
  consent          boolean not null default false,
  delivery_errors  jsonb
);

-- ---------- contact uploads from step 4 ----------
create table if not exists public.contact_uploads (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  client_key       text not null,
  client_id        text,
  business_name    text not null,
  owner_name       text,
  email            text not null,
  note             text,
  files            jsonb not null,         -- [{name, path, size, type, contacts_read}, ...]
  contacts_count   integer not null default 0,
  sheet_url        text,                   -- the client's own Google Sheet
  delivery_errors  jsonb
);

-- every contact read out of those files, one row each
create table if not exists public.contacts (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  upload_id        uuid not null references public.contact_uploads(id) on delete cascade,
  client_key       text not null,
  business_name    text not null,
  name             text,
  phone            text,
  email            text,
  company          text,
  notes            text,
  source_file      text
);

create index if not exists onboarding_responses_client_key on public.onboarding_responses (client_key);
create index if not exists voice_recordings_client_key     on public.voice_recordings (client_key);
create index if not exists contact_uploads_client_key      on public.contact_uploads (client_key);
create index if not exists contacts_client_key              on public.contacts (client_key);

alter table public.onboarding_responses enable row level security;
alter table public.voice_recordings     enable row level security;
alter table public.contact_uploads      enable row level security;
alter table public.contacts             enable row level security;

-- ---------- private file buckets ----------
-- voice: audio only, 25 MB. contacts: any file (vcf, csv, photos, pdf), 45 MB.
-- Free Supabase projects cap a single upload at 50 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('voice',    'voice',    false, 26214400, array['audio/*']),
  ('contacts', 'contacts', false, 47185920, null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
