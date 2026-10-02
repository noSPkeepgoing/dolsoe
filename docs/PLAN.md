# PLAN — 돌쇠

## 진행 상태 (재진입 원장)
- **현재**: 서브페이즈 1.2 완료(초안 생성 코어: YES24 소스·LLM 생성·품질 검사·번갈아/중복/상한/실패 스킵·스케줄러·누락 처리). 다음은 1.3 승인 흐름 + 링크 모드.
- **마지막 커밋**: 1.2 — 초안 생성 코어(REQ-001·002·003·004·005·015) + 도서 소스를 알라딘→YES24로 교체(ADR-009). 정확한 해시는 `git log`로 확인.
- **다음 액션 1개**: `/build 1.3` (승인 흐름 + 링크 모드). 착수 시 게이트 예외에서 REQ-006~011을 지우고, **텔레그램 초안 카드는 와이어프레임 1회 ■** 후 구현. 쿠팡 링크에서 상품 정보를 가져올 수 있는 범위(ADR-008)도 이때 확인한다.
- **블로커·열린 결정**:
  - 네이버 블로그 **미개설** → 1.5(네이버 API 스파이크)의 선행 조건. 1.1~1.4는 블로커 아님.
  - 쿠팡파트너스·애드포스트 가입/승인 조건 미확인(사용자 액션).
  - **알라딘 OpenAPI는 신규 키 발급 중단(2026-09-04)·종료(2026-10-30)** → 도서 소스를 YES24로 교체함(ADR-009).
  - YES24 API 키 발급(사용자, 즉시·무료)과 **애드온 신청(해제 불가 — 정책 확인 후)**, 수수료율·대가성 문구 표기 의무·자동화 관련 약관은 미확인(ADR-009). 계약의 yes24 문구는 임시. 애드온 전에는 후보가 0건(수익 링크 없음).
  - **실키 관통 미실시**: 텔레그램 봇 토큰·본인 chat_id, Anthropic 키, YES24 키가 있어야 실제 초안 생성·알림을 확인할 수 있다. 가짜 키 관통(YES24 AUTH_002 해석, DB v2, 스케줄 예약, 실패 시 무저장)은 통과.

## 토폴로지 (ADR-002)
단일 Node 프로세스(launchd KeepAlive) = 봇(grammY 롱폴링) + 스케줄러(DB `due_at` 60초 tick) + 발행 워커. 저장소 SQLite 1파일(ADR-003).

```
텔레그램 ⇄ bot ─┬─ draft(생성·검증·상태머신) ─ llm ─ Anthropic
                 ├─ sources(Yes24 / CoupangLink) ─ 외부 상품 데이터
                 ├─ scheduler(tick) ─ schedule_jobs
                 └─ publish(Orchestrator → Naver / Handoff) ─ 네이버 블로그 / 텔레그램 전달
                          ↓
                       SQLite
```

## 페이즈 1 (MVP) — 초안 생성 → 텔레그램 승인 → 발행이 하루 1편 끝까지 돈다

### ✅ 1.1 골격 + 저장소 + 봇 뼈대 + 소유자 필터
- REQ: **REQ-014**(자동)
- 프로젝트 셋업(package.json·tsconfig·eslint·vitest, jipsa 세트 참고 — ADR-001), `src/config.ts`(env 검증), `src/db.ts`(스키마·마이그레이션·row↔도메인 매퍼), 봇 뼈대(소유자 `OWNER_CHAT_ID` 외 무시, update_id 중복 방지 — ADR-004)
- 완료 조건: gate 통과, 다른 chat_id 메시지가 무시됨을 테스트

### ✅ 1.2 초안 생성 코어
- REQ: **REQ-001, 002, 003, 004, 005, 015**(모두 자동)
- 착수 전 확인: LLM 모델 ID·단가(ADR-007 — 확인 완료), YES24 응답 필드(ADR-009 — 실호출 전엔 샘플 기반)
- 소스 어댑터(YES24 — 쿠팡 링크 어댑터는 링크 모드와 함께 1.3으로 이동), 초안 생성기(LLM → `DraftBodySchema` 검증, 재시도), 품질 검사(금지 표현·경험 유무), 번갈아·중복 제외·대기 상한·실패 스킵, 스케줄 tick(KST 08:00), 기동 시 누락 처리, 월 비용 추적·상한 알림

### 🔜 1.3 승인 흐름 + 링크 모드
- REQ: **REQ-006, 007, 008, 009, 010, 011**(모두 자동)
- 초안 카드(본문 미리보기·품질 한 줄·`발행/수정/폐기`), 수정 대화(경험 한 줄 추출·원문 보존 검사), 더블탭 방지(CAS), 대가성 문구 자동 삽입·차단(공통 게이트), 링크 메시지 → 즉시 초안
- **UI 첫 등장**: 텔레그램 초안 카드는 build 시작 시 와이어프레임 1회(메시지 모양) 후 로컬에서 확인

### ⬜ 1.4 발행부 (③ 텔레그램 전달)
- REQ: **REQ-013**(자동), **REQ-012**(관통)
- `Publisher` 인터페이스, `PublishOrchestrator`(사다리·시도 로그·재시도·알림), `TelegramHandoffPublisher`, 렌더러(플랫폼 중립 본문 → 네이버용 HTML/텍스트)
- REQ-012는 실제 텔레그램·(가능하면) 네이버로 종단 관통 확인

### ⬜ 1.5 네이버 API 스파이크 → 어댑터 (블로그 개설 후)
- REQ: REQ-012 ①②
- **선행**: 사용자가 네이버 블로그 개설 + 글쓰기 API 암호 발급. 실호출로 ①live ②private 동작 확인 → 되는 만큼 `NaverApiPublisher` 추가. 안 되면 ③이 정식 MVP(PRD REQ-012 사다리)

## 페이즈 2 (요약, 상세는 승격 시)
REQ-020 검색 트렌드 주제 · 021 주간 성과 리포트 · 022 카테고리 확장(맛집=사진+메모) · 023 자체 정적 사이트 · 024 자동 발행 · 025 예약 발행 · 026 고급 품질 검사

## DB 스키마 (SQLite, `src/db.ts`가 계약과 1:1 매핑)
| 테이블 | 핵심 컬럼 | 관련 REQ/ADR |
|---|---|---|
| `drafts` | id, category, mode, status, products_json, body_json, memo, quality_json, created_at, updated_at | REQ-002·007·008 |
| `publish_attempts` | id, draft_id, mode, started_at, finished_at, result_json | REQ-012·013, ADR-006 |
| `covered_products` | source, external_id, covered_at (PK: source+external_id) | REQ-003 |
| `schedule_jobs` | id, kind, due_at, done_at | REQ-001, ADR-002 |
| `processed_updates` | update_id (PK), processed_at | REQ-009, ADR-004 |
| `llm_usage` | month (PK), estimated_cost_krw | NFR-001, ADR-007 |
| `kv` | key, value (예: 마지막 기동 시각, 마지막 생성 카테고리) | REQ-001 번갈아, EDGE-006 |

## 게이트 예외
> 아직 착수하지 않은 서브페이즈의 (자동) REQ. 해당 서브페이즈를 구현하면 **반드시 여기서 지운다**(안 지우면 테스트 없이 통과됨).

- REQ-006, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011 (1.3)
- REQ-013 (1.4)
- REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-026 (페이즈 2 — 승격 시 여기서 지운다)
