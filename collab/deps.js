// 협업 계층의 외부 의존성. 앱은 이미 Supabase를 CDN에서 로드하므로 Yjs도 ESM으로.
//
// Yjs 단일 인스턴스 보장:
//   - 'yjs' 스펙파이어는 각 HTML의 <script type="importmap">에서 단 하나의 URL로 고정.
//   - y-protocols는 ?external=yjs 로 그 'yjs' 스펙파이어를 그대로 import(사본 번들 안 함).
// 이렇게 하면 "Yjs was already imported" 경고 없이 하나의 Yjs만 로드된다.
// (importmap이 없는 환경이면 'yjs'가 안 잡히므로, 이 파일을 쓰는 HTML엔 importmap 필수)
export * as Y from 'yjs';
export {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'https://esm.sh/y-protocols@1/awareness?external=yjs';
