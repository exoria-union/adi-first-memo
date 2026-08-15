-- ============================================================================
-- 빛의왕국 편집기 · 실시간 협업 Supabase 설정 (통합본, 한 번에 실행)
-- ----------------------------------------------------------------------------
-- 이 파일 하나만 SQL Editor에 붙여넣고 Run 하면 됩니다.
-- 순서(projects 먼저 → doc_* 테이블)를 보장하고, 여러 번 실행해도 안전합니다.
-- 브라우저에는 anon/publishable key만 넣으세요. service_role key 금지.
-- ============================================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────────
-- 1) projects : 프로젝트 목록/이름 등 메타데이터
-- ────────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id text primary key,
  name text not null,
  data jsonb not null,
  version bigint not null default 1,
  owner_id uuid not null references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_projects_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_projects_updated_at();

alter table public.projects enable row level security;

-- 공유 워크스페이스: 로그인한 모두가 읽기/수정, 소유자만 삭제
drop policy if exists "authenticated users can read projects" on public.projects;
create policy "authenticated users can read projects"
  on public.projects for select to authenticated using (true);

drop policy if exists "authenticated users can create projects" on public.projects;
create policy "authenticated users can create projects"
  on public.projects for insert to authenticated with check (auth.uid() = owner_id);

drop policy if exists "authenticated users can update projects" on public.projects;
create policy "authenticated users can update projects"
  on public.projects for update to authenticated using (true) with check (true);

drop policy if exists "owners can delete projects" on public.projects;
create policy "owners can delete projects"
  on public.projects for delete to authenticated using (auth.uid() = owner_id);

-- (선택) 구버전 postgres_changes 폴백을 위한 realtime publication 등록.
-- Yjs 협업은 broadcast를 쓰므로 필수는 아님. 이미 등록돼 있으면 건너뛴다.
alter table public.projects replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────
-- 2) doc_updates / doc_snapshots : 문서의 실시간 내용(Yjs 바이너리)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.doc_updates (
  id         bigint generated always as identity primary key,
  project_id text not null references public.projects(id) on delete cascade,
  update     text not null,                         -- base64(Uint8Array) Yjs update
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists doc_updates_project_id_idx
  on public.doc_updates (project_id, id);

create table if not exists public.doc_snapshots (
  project_id     text primary key references public.projects(id) on delete cascade,
  snapshot       text not null,                     -- base64(Uint8Array) 전체 상태
  last_update_id bigint not null default 0,
  updated_at     timestamptz not null default now()
);

create or replace function public.set_doc_snapshots_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists doc_snapshots_set_updated_at on public.doc_snapshots;
create trigger doc_snapshots_set_updated_at
before update on public.doc_snapshots
for each row execute function public.set_doc_snapshots_updated_at();

alter table public.doc_updates   enable row level security;
alter table public.doc_snapshots enable row level security;

drop policy if exists "auth read doc_updates" on public.doc_updates;
create policy "auth read doc_updates"   on public.doc_updates
  for select to authenticated using (true);

drop policy if exists "auth insert doc_updates" on public.doc_updates;
create policy "auth insert doc_updates" on public.doc_updates
  for insert to authenticated with check (true);

drop policy if exists "auth delete doc_updates" on public.doc_updates;
create policy "auth delete doc_updates" on public.doc_updates
  for delete to authenticated using (true);

drop policy if exists "auth read doc_snapshots" on public.doc_snapshots;
create policy "auth read doc_snapshots"   on public.doc_snapshots
  for select to authenticated using (true);

drop policy if exists "auth write doc_snapshots" on public.doc_snapshots;
create policy "auth write doc_snapshots" on public.doc_snapshots
  for all to authenticated using (true) with check (true);

-- 완료. 이제 index.html의 SUPABASE_CONFIG에 URL + anon key를 넣으세요.
