# Supabase 설정 가이드 (처음부터)

빛의왕국 편집기의 실시간 협업을 켜려면 Supabase(무료로 시작 가능한 백엔드)가 필요합니다. 아래 순서대로 하면 됩니다. 대략 **15분**이면 끝납니다. 신용카드 필요 없습니다.

> 화면 메뉴 이름은 Supabase 업데이트로 조금씩 바뀔 수 있습니다. "무엇을 찾는지"를 함께 적어두니 이름이 달라도 찾을 수 있습니다.

---

## 1단계 — 계정 만들고 프로젝트 생성

1. https://supabase.com 접속 → **Start your project** → GitHub 또는 이메일로 가입.
2. 대시보드에서 **New project** 클릭.
3. 입력:
   - **Name:** 아무 이름 (예: `lumkingdom`)
   - **Database Password:** 강한 비밀번호 생성(자동 생성 버튼 추천). **어딘가 저장**해 두세요 — 나중에 DB 직접 접속할 때만 쓰이고, 앱에는 안 들어갑니다.
   - **Region:** 사용자와 가까운 곳(한국이면 `Northeast Asia (Seoul)` 또는 `Tokyo`).
   - **Plan:** Free.
4. **Create new project** → 준비까지 1~2분 대기(초록불이 켜질 때까지).

---

## 2단계 — SQL 두 개 실행 (테이블·권한 만들기)

왼쪽 사이드바에서 **SQL Editor**(아이콘: `>_` 또는 "SQL")를 엽니다.

1. **New query** 클릭.
2. 프로젝트 폴더의 **`supabase_협업_전체설정.sql`** 파일 내용을 전부 복사해 붙여넣고 → 오른쪽 아래 **Run**(또는 Ctrl/Cmd+Enter).
   - "Success. No rows returned" 비슷한 메시지가 나오면 성공.

> 이 파일 **하나가** `projects`(프로젝트 목록)과 `doc_updates`·`doc_snapshots`(문서 실시간 내용) 테이블 + 접근 권한(RLS)을 올바른 순서로 전부 만듭니다. 여러 번 실행해도 안전합니다.
>
> (참고: 예전 두 파일 `supabase_빛의왕국_협업_초기설정.sql` + `supabase_yjs_협업_migration.sql`을 순서대로 돌려도 되지만, 순서가 바뀌면 `relation "public.projects" does not exist` 오류가 납니다. 통합본 하나가 안전합니다.)

---

## 3단계 — 연결 값(URL · anon key) 복사

1. 왼쪽 아래 **Project Settings**(톱니바퀴) → **API** 메뉴.
2. 두 값을 복사합니다:
   - **Project URL** — `https://xxxxxxxx.supabase.co` 형태.
   - **anon public key** (또는 **Publishable key**) — `eyJ...`로 시작하는 긴 문자열.
3. ⚠️ 같은 화면의 **`service_role` key는 절대 복사해서 앱에 넣지 마세요.** 그건 관리자 키라 브라우저에 노출되면 안 됩니다. 우리가 쓰는 건 **anon/publishable** 뿐입니다.

---

## 4단계 — 앱에 값 넣기

`index.html`을 편집기로 열고 맨 위쪽의 `SUPABASE_CONFIG`를 찾아(약 536번째 줄) 값을 채웁니다:

```js
var SUPABASE_CONFIG = {
  url: "https://xxxxxxxx.supabase.co",      // 3단계의 Project URL
  anonKey: "eyJhbGciOi..."                  // 3단계의 anon public key
};
```

저장하면 끝입니다.

---

## 5단계 — 팀 계정 만들기 & 가입 잠그기 (소규모 팀 권장)

지금 설정은 "**로그인한 사람은 모두 모든 프로젝트를 공유**"입니다. 그래서 **아는 사람만 로그인**하게 만드는 게 중요합니다.

**A. 팀원 계정 직접 만들기** (Authentication → **Users** → **Add user** → *Create new user*):
- 팀원 각자의 이메일 + 임시 비밀번호를 넣어 계정을 만들고 전달하세요.
- 여기서 만들면 이메일 인증 없이 바로 로그인됩니다.

**B. 아무나 가입 못 하게 잠그기** (Authentication → **Sign In / Providers**, 또는 **Policies/Settings**):
- **"Allow new users to sign up"**(신규 가입 허용) 토글을 **끕니다**.
- 이러면 위 A에서 만든 계정만 로그인할 수 있습니다.

> 참고: 가입을 열어둔 채로 이메일 인증만 요구하고 싶다면, Authentication → **Providers → Email** 에서 **Confirm email**을 켜 두면 됩니다(가입 시 인증 메일이 갑니다). 소규모 팀이면 **A+B(직접 생성 + 가입 잠금)** 가 가장 깔끔합니다.

---

## 6단계 — http로 열기 (중요)

앱은 ES 모듈을 쓰기 때문에 **파일 더블클릭(`file://`)으로는 협업이 안 켜집니다.** 반드시 http(s)로 열어야 합니다.

- **로컬에서 테스트:** 프로젝트 폴더에서 터미널로
  ```bash
  py -m http.server 8000
  ```
  실행 후 브라우저에서 `http://localhost:8000/` 접속.
- **배포:** 기존처럼 **GitHub Pages** 등 정적 호스팅에 폴더째 올리면 됩니다(`collab/` 폴더도 함께).

---

## 7단계 — 둘이서 확인

1. 배포한 주소를 **서로 다른 브라우저(또는 시크릿 창)** 두 개에서 엽니다.
2. 각각 다른 팀 계정으로 로그인.
3. 우측 상단에 서로의 **아바타**가 뜨는지 확인.
4. 한 명이 지도 칸을 열어 **본문 스크립트**를 타이핑 → 다른 화면에 실시간으로 나타나는지 확인.
5. **같은 칸을 동시에** 편집해도 양쪽 내용이 모두 남는지 확인.

---

## 잘 안 될 때

| 증상 | 원인 / 해결 |
|---|---|
| `relation "public.projects" does not exist` | SQL을 순서 없이 돌린 경우. **`supabase_협업_전체설정.sql` 하나만** 실행하세요(순서·의존성 자동 처리). |
| "Supabase 미설정" 표시 | 4단계 값이 비었거나 `YOUR_...` 그대로. `SUPABASE_CONFIG` 확인. |
| "실시간 연결 실패" 토스트 | 2단계 SQL(특히 두 번째 파일) 미실행. SQL Editor에서 다시 실행. |
| 로그인은 되는데 협업이 안 켜짐 | `file://`로 열었을 가능성. http로 여세요(6단계). |
| "이메일 인증이 필요" | 5단계에서 계정을 직접 만들거나, Confirm email을 끄세요. |
| 아바타/실시간이 안 뜸 | 브라우저 콘솔(F12) 확인. 대개 SQL 미실행 또는 잘못된 anon key. |

## 비용
소규모 팀(수 명, 프로젝트 몇 개)이면 **무료 플랜으로 충분**합니다. Realtime·DB 모두 무료 한도 안에서 동작합니다.
