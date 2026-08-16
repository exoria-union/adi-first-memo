# CLAUDE.md — 빛의왕국 탐사맵 편집기

게임 탐사맵 데이터를 편집하는 **단일 HTML 앱**(`index.html`)이다. **실시간 협업(Yjs over Supabase, 무빌드)** 과 **bot_area용 SQL 내보내기**가 붙어 있다. 정적 파일로 GitHub Pages에 배포한다.

> ⚠️ 이 문서는 협업/데이터 유실 관련 **이미 겪은 버그와 함정**을 다시 밟지 않도록 정리한 것이다. 협업 코드를 건드리면 아래 "테스트" 절차를 반드시 돌린다.

## 레포 구조
- `index.html` — 앱 전체(거대함, 임베드 데이터가 한 줄 ~500KB). **줄 범위 말고 고유 앵커로 Edit**할 것.
- `collab/` — 협업 엔진(무빌드, CDN에서 Yjs 로드):
  - `deps.js` — import map으로 `yjs` 단일 인스턴스 + y-protocols(`?external=yjs`).
  - `ydoc.js` — **DATA ↔ Y.Doc 브리지**(reconcile, 텍스트 diff). 리치텍스트 칸만 Y.Text.
  - `provider.js` — Supabase 전송(broadcast) + 영속(`doc_updates`/`doc_snapshots`) + **localStorage Yjs 캐시** + awareness.
  - `index.js` — 공개 API(`openProject()` → session: push/readCurrent/bindText/setEditing…).
  - `presence.js` / `presence.css` — 접속자 아바타.
- `supabase_협업_전체설정.sql` — DB 한 방 설정(Supabase SQL Editor에서 실행).
- `collab-selftest*.html` — **오프라인 자체 테스트(협업 수정 후 필수 실행)**.
- `SUPABASE-설정가이드.md`, `README-협업.md` — 설정/사용 문서.

## 협업 데이터 흐름
- 편집 → `markDirty` → `persist()`(localStorage 동기 저장) → `COLLAB.push(DATA)` → `reconcile(DATA vs shadow)` → Y.Doc → provider가 broadcast + 영속.
- 원격 수신 → `onRemote` → `applyRemoteData(incoming)` → DATA 교체 + 재렌더.
- **문서 내용의 정본은 Yjs 문서(doc_updates + doc_snapshots)** 다. `projects.data`는 **협업 전환 후 갱신 안 되는 stale 시드**이니 신뢰하지 말 것(목록의 name/updated_at 용도로만).

## ⚠️ 반드시 지킬 함정 (이미 터진 버그들)
1. **reconcile은 행을 고정폭으로 다루면 안 된다.** `ensureBotAreaColumns()`가 새 컬럼(`최초 유일 지급 여부`·`유일 아이템 소진 스크립트`·`갈림길 그룹`)을 추가하면 데이터 행이 Yjs 행보다 길어진다 → `reconcileRow`는 범위 초과 삭제 대신 **append(빈 칸 null 채움)** 해야 한다. (안 지키면 `"Length exceeded!"`로 push가 죽어 편집 유실.)
2. **`applyRemoteData`는 텍스트 칸 편집 중엔 DATA/localStorage를 건드리면 안 된다.** `isTextTarget`를 **맨 먼저** 확인해 `__pendingRemote`에 보류하고, blur 시 `COLLAB.push(DATA)`로 로컬 확정 후 `readCurrent()` 병합본을 반영. (안 지키면 입력 중 편집이 원격본에 덮여 사라짐.)
3. **broadcast 청크는 "각각 다른 메시지"로 보낸다**(256KB 한도). 수신측은 `_reasm`에 id별로 모아 재조립. 한 메시지에 청크 전부 담으면 대용량이 통째로 실패한다.
4. **협업 연결 실패 시 DATA를 localStorage 최신본으로 복구**(stale `projects.data` 시드로 두면 "초기화"처럼 보임).
5. **provider의 localStorage Yjs 캐시**(`_saveLocal`, 키 `ydoc_local_<projectId>`)가 부팅 복구 안전망이다. localStorage는 동기라 이탈 시에도 남는다 → 부팅 시 Supabase 로드 후 CRDT로 덧입혀 복구(원격 되돌림 없음). 유지할 것.
6. **Yjs 단일 인스턴스:** import map이 `yjs`를 한 URL로 고정. 다른 URL로 yjs를 또 import하지 말 것("Yjs was already imported").

## 협업 수정 후 테스트 (항상)
ES 모듈이라 **http로 서빙 필수**: `py -m http.server 8000`(또는 `python3 -m http.server`). 브라우저로:
- `collab-selftest.html` — DATA↔Y 브리지(라운드트립·동시 병합). 제목이 `BRIDGE OK`여야 함.
- `collab-selftest2.html` — provider(인메모리 Supabase 목): 시드/로드·broadcast·라이브 텍스트·**대용량 다중청크**·localStorage 복구. `PROVIDER OK`.
- `collab-selftest3.html` — 스트레스: 행 삭제/추가/재정렬/동시, **마이그레이션 sparse 행**, 청크 재조립. `STRESS OK`.
- 그리고 `index.html` 로드 후 콘솔 오류 0 확인. (Supabase 없이도 앱은 localStorage 모드로 뜬다.)

## 데이터 유실 수정 이력
① 편집 중 원격 덮어씀 → 보류/blur 병합. ② 협업 실패 시 stale 시드 → localStorage 복구. ③ 부팅 flush 전 유실 → localStorage Yjs 캐시 복구. ④ 새 컬럼 편집 시 reconcile 크래시 → append. ⑤ 대용량 실시간 전파 실패 → 청크 개별 메시지+재조립.

## index.html 편집 팁
주요 함수: `persist`·`markDirty`·`applyRemoteData`·`startCollab`·`onCloudSignedIn`·`rebuildProjectView`·`renderNodePanel`·`ensureBotAreaColumns`·`buildBotAreaSql`·`fieldInput/fieldSelect/fieldTextarea`(라벨로 `FIELD_HINTS` 자동 각주). **사용자가 병렬로 자주 푸시하니, 편집 전 `git pull` 하고 충돌 시 rebase.**

## bot_area SQL 내보내기
툴바 [SQL 내보내기]. 시트 컬럼→`bot_area` 매핑, up_area_id/start_point는 모달 입력. 검증: 길이 초과·**4바이트 문자(테이블이 utf8mb3라 이모지 불가)**·INT 칸 비숫자값 → 행 제외+리포트(생성 SQL은 오류 안 남). 상세는 `README-협업.md` / 메모리 `bot-area-export`.

## 배포/설정
`index.html` 상단 `SUPABASE_CONFIG`(anon key). `supabase_협업_전체설정.sql` 실행. http로 배포(Pages). 공유 워크스페이스 RLS라 **가입 잠그기 권장**(로그인한 누구나 전체 열람).
