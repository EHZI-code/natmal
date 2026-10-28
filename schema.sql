-- 낱말장 데이터베이스
-- Supabase 대시보드 → SQL Editor에 이 파일 내용을 통째로 붙여 넣고 Run을 누르세요.

create table if not exists public.words (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body        jsonb not null,
  sort        double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists words_user_sort on public.words (user_id, sort);

-- 앱(로그인한 사람)이 이 표를 쓸 수 있게 권한을 준다.
-- "Automatically expose new tables"를 꺼 둔 경우에도 이 줄 덕분에 동작한다. 로그인하지 않은 사람(anon)에게는 주지 않는다.
revoke all on public.words from anon;
grant select, insert, update, delete on public.words to authenticated;

-- 행 보안: 자기 낱말만 읽고 쓸 수 있다
alter table public.words enable row level security;

drop policy if exists "own words: select" on public.words;
drop policy if exists "own words: insert" on public.words;
drop policy if exists "own words: update" on public.words;
drop policy if exists "own words: delete" on public.words;

create policy "own words: select" on public.words for select using (auth.uid() = user_id);
create policy "own words: insert" on public.words for insert with check (auth.uid() = user_id);
create policy "own words: update" on public.words for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own words: delete" on public.words for delete using (auth.uid() = user_id);

-- 수정 시각 자동 갱신
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists words_touch on public.words;
create trigger words_touch before update on public.words for each row execute function public.touch_updated_at();

-- 다른 기기에서 바꾼 내용이 바로 보이도록 실시간 알림 켜기
do $$ begin
  alter publication supabase_realtime add table public.words;
exception when duplicate_object then null; end $$;
