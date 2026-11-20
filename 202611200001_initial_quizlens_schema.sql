-- QuizLens AI initial Supabase schema.
-- Apply with the Supabase CLI or the Supabase SQL editor in a project you own.
-- Screenshots belong in the private `question-captures` bucket under:
--   <auth-user-id>/<audit-session-id>/<question-id>/<filename>

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.audit_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text check (description is null or char_length(description) <= 2_000),
  status text not null default 'active' check (status in ('active', 'paused', 'completed')),
  started_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (ended_at is null or ended_at >= started_at)
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.audit_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_number integer not null check (question_number > 0),
  capture_source text not null default 'upload' check (capture_source in ('screen', 'camera', 'upload', 'manual')),
  image_path text,
  extracted_text text,
  question_type text not null default 'unknown' check (question_type in ('single_choice', 'multiple_choice', 'assertion_reason', 'unknown')),
  options_json jsonb not null default '[]'::jsonb check (jsonb_typeof(options_json) = 'array'),
  suggested_answer_json jsonb not null default '[]'::jsonb check (jsonb_typeof(suggested_answer_json) = 'array'),
  answer_text text,
  explanation text,
  confidence text check (confidence is null or confidence in ('high', 'medium', 'low', 'insufficient_information')),
  verification_status text not null default 'needs_verification' check (verification_status in ('needs_verification', 'verified', 'contradicted')),
  audit_flags_json jsonb not null default '[]'::jsonb check (jsonb_typeof(audit_flags_json) = 'array'),
  notes text,
  captured_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (session_id, question_number)
);

create table if not exists public.verification_sources (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_url text not null check (source_url ~* '^https?://'),
  verification_result text not null check (verification_result in ('supports', 'contradicts', 'reference')),
  notes text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists audit_sessions_user_updated_idx on public.audit_sessions (user_id, updated_at desc);
create index if not exists questions_user_created_idx on public.questions (user_id, created_at desc);
create index if not exists questions_session_number_idx on public.questions (session_id, question_number);
create index if not exists questions_verification_status_idx on public.questions (user_id, verification_status);
create index if not exists verification_sources_question_created_idx on public.verification_sources (question_id, created_at desc);

create or replace function public.quizlens_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.quizlens_set_updated_at();

create trigger set_audit_sessions_updated_at
before update on public.audit_sessions
for each row execute function public.quizlens_set_updated_at();

create trigger set_questions_updated_at
before update on public.questions
for each row execute function public.quizlens_set_updated_at();

-- Keep the denormalized question owner identical to the owning audit session.
create or replace function public.quizlens_enforce_question_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  session_owner uuid;
begin
  select user_id into session_owner
  from public.audit_sessions
  where id = new.session_id;

  if session_owner is null then
    raise exception 'audit session does not exist';
  end if;

  if new.user_id is distinct from session_owner then
    raise exception 'question user_id must match its audit session owner';
  end if;

  return new;
end;
$$;

create trigger enforce_question_owner
before insert or update of session_id, user_id on public.questions
for each row execute function public.quizlens_enforce_question_owner();

-- Keep verification evidence owned by the same user as its question.
create or replace function public.quizlens_enforce_verification_source_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  question_owner uuid;
begin
  select user_id into question_owner
  from public.questions
  where id = new.question_id;

  if question_owner is null then
    raise exception 'question does not exist';
  end if;

  if new.user_id is distinct from question_owner then
    raise exception 'verification source user_id must match its question owner';
  end if;

  return new;
end;
$$;

create trigger enforce_verification_source_owner
before insert or update of question_id, user_id on public.verification_sources
for each row execute function public.quizlens_enforce_verification_source_owner();

-- Create an app profile at Supabase Auth signup. The trigger runs with owner
-- privileges because a signing-in user cannot normally insert another table row.
create or replace function public.quizlens_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger quizlens_on_auth_user_created
after insert on auth.users
for each row execute function public.quizlens_handle_new_user();

alter table public.profiles enable row level security;
alter table public.audit_sessions enable row level security;
alter table public.questions enable row level security;
alter table public.verification_sources enable row level security;

create policy "Profiles are readable by their owner"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "Profiles are editable by their owner"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can create their own profile"
on public.profiles for insert to authenticated
with check ((select auth.uid()) = id);

create policy "Users can read their audit sessions"
on public.audit_sessions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their audit sessions"
on public.audit_sessions for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their audit sessions"
on public.audit_sessions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their audit sessions"
on public.audit_sessions for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their questions"
on public.questions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their questions"
on public.questions for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their questions"
on public.questions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their questions"
on public.questions for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their verification sources"
on public.verification_sources for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their verification sources"
on public.verification_sources for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their verification sources"
on public.verification_sources for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their verification sources"
on public.verification_sources for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.audit_sessions to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select, insert, update, delete on public.verification_sources to authenticated;

-- Private screenshot storage. The first object path segment is always auth.uid().
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'question-captures',
  'question-captures',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read their private captures"
on storage.objects for select to authenticated
using (
  bucket_id = 'question-captures'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can upload their private captures"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'question-captures'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can update their private captures"
on storage.objects for update to authenticated
using (
  bucket_id = 'question-captures'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'question-captures'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can delete their private captures"
on storage.objects for delete to authenticated
using (
  bucket_id = 'question-captures'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
