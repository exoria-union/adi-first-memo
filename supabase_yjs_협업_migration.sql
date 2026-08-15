-- ============================================================================
-- 빛의왕국 탐사맵 편집기: Yjs(CRDT) 실시간 협업 영속 계층
-- ----------------------------------------------------------------------------
-- 기존 supabase_빛의왕국_협업_초기설정.sql 을 먼저 실행한 뒤 이 파일을 실행하세요.
-- (projects 테이블 = 프로젝트 목록/이름 메타데이터로 계속 사용)
--
-- 문서의 "실시간 내용"은 이제 아래 두 테이블에 Yjs 바이너리로 저장됩니다:
--   doc_updates   : append-only 업데이트 로그(내구성의 원천)
--   doc_snapshots : 주기적 전체 스냅샷(로그 압축용)
-- 라이브 동기화는 Realtime "broadcast" 채널로 처리하므로, 이 테이블들을
-- realtime publication에 추가할 필요는 없습니다(postgres_changes 안 씀).
--
-- 공유 범위: '로그인한 협업자 모두 공유'(현재 모델 유지). 프로젝트별 초대제로
-- 바꾸려면 project_members 를 두고 아래 using(true) 를 멤버십 검사로 교체하세요.
-- ============================================================================

-- 업데이트 로그: 각 클라이언트가 만든 Yjs 업데이트(base64)를 순서대로 쌓는다.
create table if not exists public.doc_updates (
  id         bigint generated always as identity primary key,
  project_id text not null references public.projects(id) on delete cascade,
  update     text not null,                         -- base64(Uint8Array) Yjs update
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists doc_updates_project_id_idx
  on public.doc_updates (project_id, id);

-- 스냅샷: 프로젝트당 1행. 전체 상태 + 이 스냅샷이 포함하는 마지막 update id.
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

-- ---- RLS: 공유 워크스페이스(로그인한 모두 읽기/쓰기) ----
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

-- ---- (선택) Realtime Authorization을 켠 프로젝트라면 broadcast 허용 정책 필요 ----
-- 기본 설정에서는 authenticated 사용자의 broadcast/presence가 이미 허용됩니다.
-- realtime.messages 에 RLS를 켜 두었다면 아래를 활성화하세요:
-- create policy "auth can broadcast ydoc" on realtime.messages
--   for select to authenticated using (true);
-- create policy "auth can send ydoc" on realtime.messages
--   for insert to authenticated with check (true);
