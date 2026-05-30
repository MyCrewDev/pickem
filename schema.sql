-- Pick'em data model (lives in public, prefixed to stay namespaced; RLS on).
-- service_role bypasses RLS; the edge function is the only reader/writer.

create table if not exists public.pickem_matches (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  competition text,
  home text not null,
  away text not null,
  venue text,
  kickoff timestamptz,
  status text not null default 'open',          -- 'open' | 'closed'
  created_at timestamptz not null default now()
);

create table if not exists public.pickem_bets (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.pickem_matches(id) on delete cascade,
  n int not null,
  title text not null,
  blurb text,
  opt_a text not null,
  opt_b text not null,
  correct char(1),                               -- 'A' | 'B', set after the match
  settle_note text,
  unique (match_id, n)
);

create table if not exists public.pickem_entries (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.pickem_matches(id) on delete cascade,
  player text not null,
  picks jsonb not null,                          -- { "1":"A", "2":"B", ... }
  submitted_at timestamptz not null default now()
);
create index if not exists pickem_entries_match_idx on public.pickem_entries(match_id);

alter table public.pickem_matches enable row level security;
alter table public.pickem_bets    enable row level security;
alter table public.pickem_entries enable row level security;

grant all on public.pickem_matches to service_role;
grant all on public.pickem_bets    to service_role;
grant all on public.pickem_entries to service_role;
grant usage, select on all sequences in schema public to service_role;
