-- 빛의왕국 탐사맵 편집기: Supabase 초기 설정
-- 브라우저에는 publishable/anon key만 넣고 service_role key는 절대 넣지 마세요.

create extension if not exists pgcrypto;

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
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_projects_updated_at();

alter table public.projects enable row level security;

-- 이 버전은 '로그인한 협업자 모두가 모든 프로젝트를 볼 수 있는' 공유 워크스페이스입니다.
-- 프로젝트별 비공개/초대제 모델로 바꾸려면 별도의 project_members 테이블을 추가하면 됩니다.
drop policy if exists "authenticated users can read projects" on public.projects;
create policy "authenticated users can read projects"
on public.projects for select
to authenticated
using (true);

drop policy if exists "authenticated users can create projects" on public.projects;
create policy "authenticated users can create projects"
on public.projects for insert
to authenticated
with check (auth.uid() = owner_id);

drop policy if exists "authenticated users can update projects" on public.projects;
create policy "authenticated users can update projects"
on public.projects for update
to authenticated
using (true)
with check (true);

drop policy if exists "owners can delete projects" on public.projects;
create policy "owners can delete projects"
on public.projects for delete
to authenticated
using (auth.uid() = owner_id);

-- Postgres Changes를 사용할 테이블을 Realtime publication에 추가합니다.
alter table public.projects replica identity full;
alter publication supabase_realtime add table public.projects;
