# 빛의왕국 편집기 · 실시간 협업(Yjs CRDT)

여러 사용자가 각자 브라우저에서 편집한 내용을 **실시간으로 공유·저장**하고, **같은 필드를 동시에 편집해도 한 글자도 잃지 않는**(CRDT) 협업 계층입니다. 빌드 스텝 없이 동작합니다 — 앱이 이미 Supabase를 CDN에서 불러오듯, Yjs도 ESM으로 불러옵니다.

---

## 지금 켜는 법 (3단계)

### 1. Supabase 준비
1. Supabase 프로젝트를 만들고 **Project URL**과 **anon(publishable) key**를 확보합니다.
2. SQL Editor에서 **두 파일을 순서대로** 실행합니다:
   - `supabase_빛의왕국_협업_초기설정.sql` — `projects` 테이블(프로젝트 목록/메타)·인증·RLS
   - `supabase_yjs_협업_migration.sql` — `doc_updates`·`doc_snapshots`(문서 실시간 내용 저장)

### 2. 설정값 입력
`index.html` 상단 `SUPABASE_CONFIG`에 값을 채웁니다. **service_role key는 절대 넣지 마세요.**
```js
var SUPABASE_CONFIG = {
  url: "https://xxxx.supabase.co",
  anonKey: "eyJ...(anon/publishable key)"
};
```

### 3. http로 배포
- ES 모듈을 쓰므로 **반드시 http(s)로 서빙**해야 합니다(파일 더블클릭 `file://` 불가). 기존처럼 GitHub Pages 등 정적 호스팅에 폴더째 올리면 됩니다.
- 로컬 확인: 프로젝트 폴더에서 `py -m http.server 8000` 후 `http://localhost:8000/`.
- 팀 계정만 쓰려면 Supabase Auth에서 가입을 막고 계정을 미리 만드세요.

> 미설정 상태(`YOUR_...`)면 앱은 기존처럼 **localStorage 단독(단일 사용자)** 으로 동작합니다. 협업은 로그인 이후에만 켜집니다.

---

## 무엇이 어떻게 동작하나

```
편집 → (앱) persist() → COLLAB.push(DATA)
     → [ydoc.js] DATA를 직전 스냅샷과 diff → 바뀐 부분만 Y.Doc에 적용
       · 긴 텍스트 칸은 Y.Text(글자 단위)  → 같은 칸 동시 편집도 무손실 병합
       · 그 외는 값/구조 단위
     → [provider.js]
       · 전송: Supabase Realtime broadcast 채널로 Yjs 업데이트 방송(순서·중복에 강함)
       · 영속: doc_updates(append 로그) + doc_snapshots(주기적 압축)
       · 프레즌스: y-protocols Awareness로 "누가 접속·편집 중"
원격 변경 수신 → Y.Doc 병합 → readProject() → 앱 DATA 갱신 → 재렌더
              (텍스트 입력 중이면 커서 보호를 위해 blur까지 렌더 보류)
```

- **공유 범위:** 로그인한 협업자 **모두가 모든 프로젝트를 공유**(현재 모델). 소규모 신뢰 팀 기준.
- **개인 설정**(태그색·폰트·시트이름 등)은 공유하지 않고 사용자별 localStorage로 유지합니다.
- **Yjs 단일 인스턴스:** `index.html`의 `<script type="importmap">`이 `yjs`를 한 URL로 고정하고, y-protocols는 `?external=yjs`로 그것을 공유합니다("Yjs was already imported" 경고 방지).

### 파일 구성
| 파일 | 역할 |
|---|---|
| `collab/deps.js` | Yjs·y-protocols CDN 의존성 고정 |
| `collab/ydoc.js` | DATA ↔ Y.Doc 브리지(변환·재조정·텍스트 diff) |
| `collab/provider.js` | Supabase 전송·영속·프레즌스 프로바이더 |
| `collab/presence.js` / `.css` | 접속자 아바타·편집 표시 UI |
| `collab/index.js` | 공개 API(`openProject`) |
| `supabase_yjs_협업_migration.sql` | 영속 테이블 + RLS |
| `collab-selftest.html` / `collab-selftest2.html` | 오프라인 자체 테스트(선택) |

---

## 검증 상태 (정직하게)

**오프라인으로 검증 완료** — 브라우저에서 실제 Yjs로 실행:
- `collab-selftest.html` → **15/15**: DATA↔Y 라운드트립, 개인키 제외, "최초 1회만 빌드", **같은 셀 동시 편집 무손실 수렴**, 다른 행 동시 편집 병합.
- `collab-selftest2.html` → **20/20** (인메모리 Supabase 목): 시드→영속→로드, 실시간 양방향 전파·수렴, 라이브 타이핑, 원격→입력요소 반영, 청크 분할, **본문 접두부 편집이 선택지 보존**, **합성 셀 동시편집(본문+선택지) 양쪽 보존**, `observeCellText` 원격 수신.
- `index.html` 로드 시 콘솔 오류 0, 협업 엔진 로드, 노드 패널 열림·본문/비고 편집 동작 확인, 미설정 시 기존 동작 유지.
  - 자체 테스트 실행: 위 http 서버로 `http://localhost:8000/collab-selftest.html` 접속.

**아직 실제로 확인 못 한 것** — 여러분의 Supabase 프로젝트가 있어야 검증 가능:
- 실제 Realtime broadcast 왕복과 `doc_updates`/`doc_snapshots` RLS 동작.
- **켠 뒤 반드시 2개 브라우저(또는 시크릿 창)로** 로그인해 서로 다른 칸·같은 칸을 동시에 편집하며 확인하세요.

---

## 지도 칸 편집 — 글자 단위 실시간 (배선 완료)

노드 패널(지도 칸 편집)의 텍스트 필드는 키 입력마다 즉시 동기화됩니다.

- **본문 스크립트/성공/실패 스크립트:** `scriptFieldEditor`의 본문(narrative) textarea가 `session.applyCellTextEdit`로 셀 Y.Text의 **접두부 span**에만 diff를 적용합니다. 본문은 항상 선택지("▶[지역/…]") 앞에 오므로, 선택지 접미부를 건드리지 않고 본문만 글자 단위로 병합됩니다. 한글 IME 조합·커서 위치를 보존합니다.
- **비고:** 열과 1:1이라 `session.bindText`로 통째 바인딩됩니다.
- **선택지 목록 편집**은 기존 `sync → reconcile`(무손실, ~0.7초 debounce) 경로를 씁니다. 편집 빈도가 낮고 접미부라 이 편이 안전합니다.
- **원격 변경 반영:** 본문/비고는 `observeCellText`로 편집 중에도 커서를 지키며 실시간 갱신됩니다. 선택지 등 나머지 필드는 포커스가 빠질 때(또는 패널을 다시 열 때) 갱신됩니다.
- 패널을 닫거나 다시 렌더할 때 모든 바인딩은 자동 해제됩니다(`collabClearPanelBindings`).

> 알려진 한계: 두 사람이 **정확히 같은 글자 위치**를 동시에 덮어쓰면 Yjs 규칙대로 양쪽 입력이 모두 남아(유실은 없음) 순간적으로 뒤섞일 수 있습니다. 선택지를 한쪽이 편집하는 동안 다른 쪽이 같은 셀 본문을 편집하는 등 **서로 다른 부분** 편집은 매끄럽게 병합됩니다.

## 다음에 손볼 만한 것 (선택)

- **선택지 목록도 글자 단위로:** 지금은 본문만 라이브입니다. 선택지도 즉시 반영하려면 각 선택지 입력을 개별 Y.Text 항목으로 모델링하면 됩니다(구조 변경 필요).
- **로그 압축을 서버로:** 현재는 클라이언트가 150개 업데이트마다 스냅샷+정리합니다. 트래픽이 커지면 Supabase Edge Function/cron으로 옮기세요.
- **프로젝트별 초대제:** 공유 워크스페이스 대신 특정인만 초대하려면 `project_members(project_id,user_id,role)`를 두고 RLS의 `using(true)`를 멤버십 검사로 교체하세요.
- **버전 고정:** 운영 안정성을 위해 `collab/deps.js`와 import map의 `yjs@13`을 정확한 패치(예: `yjs@13.6.21`)로 고정하세요.
- **신규 프로젝트 목록 이름 동기화:** 제목 변경이 `projects.name`(목록 표시용)에는 즉시 반영되지 않습니다. 필요하면 제목 변경 시 `projects` 행을 갱신하세요.

---

## 문제 해결
- **콘솔에 "Yjs was already imported":** import map이 없거나 `deps.js`가 캐시된 경우. 하드 리로드하고, 이 HTML에 import map이 있는지 확인.
- **"실시간 연결 실패" 토스트:** 대개 `supabase_yjs_협업_migration.sql` 미실행. 두 SQL을 모두 돌렸는지 확인. 실패해도 localStorage 저장은 계속 동작합니다.
- **모듈이 안 뜸(`file://`):** http로 서빙해야 합니다.
