# CONVENTIONS — 코드 헌법 (돌쇠)

> 목적: 모든 파일이 "동일한 한 명의 개발자"가 쓴 것처럼 보이게 한다.
> 사람 합의용이고, 실제 강제는 eslint + 타입체커(strict) + vitest + gate.sh.
> 원칙: KISS · YAGNI · DRY · andrej-karpathy-skills(과설계 금지, 수술적 변경).
> jipsa CONVENTIONS를 바탕으로 하되 돌쇠 구조에 맞게 조정.

## 1. 언어·타입
- TypeScript strict(`noUncheckedIndexedAccess` 포함). `any` 금지(불가피하면 `unknown` + 좁히기).
- 타입은 수동 정의 대신 **스키마 → 추론**(`z.infer`). 계약은 `docs/contract/domain.ts`가 유일 출처.

## 2. 네이밍
| 대상 | 규칙 |
|---|---|
| 파일 | kebab-case (`quality-check.ts`) |
| 타입/인터페이스 | PascalCase |
| 함수·변수 | camelCase |
| 상수 | UPPER_SNAKE, `docs/contract/domain.ts`에 모아둠 |
| 불리언 | is/has/should 접두 |

## 3. 상수 분리 (매직값 금지)
- 대기 상한(3), 중복 제외 일수, 스케줄 시각, 재시도 횟수, 월 비용 상한, 금지 표현, 대가성 문구는 리터럴로 흩뿌리지 않고 계약의 상수만 참조한다.
- 비밀값(봇 토큰·chat_id·API 키·네이버 인증)은 코드/저장소에 넣지 않고 `.env`만(NFR-003). `.env.example`에 키 이름만 둔다.

## 4. 폴더 구조 (경계 = 소통 규칙)
```
dolsoe/
├── docs/{contract/domain.ts, adr/, PRD.md, PLAN.md, CONVENTIONS.md}
├── scripts/gate.sh
├── src/
│   ├── main.ts               # 단일 진입점: 봇+스케줄러 기동 (launchd KeepAlive)
│   ├── config.ts             # env → zod 검증
│   ├── db.ts                 # SQLite 접근·마이그레이션, row↔도메인 매퍼 (유일한 SQL 위치)
│   ├── schedule/             # time.ts(KST 계산·기동 계획), scheduler.ts(60초 tick, due_at 실행)
│   ├── jobs/                 # daily-draft.ts: 일일 초안 작업(상한→소스→중복→생성→저장). 의존성은 인자로 주입
│   ├── bot/                  # grammY: 미들웨어(소유자 필터), 핸들러, 초안 카드 포맷터
│   ├── draft/                # rules.ts(번갈아·중복·상한), quality-check.ts, generate.ts(생성 루프), store.ts(SQLite 저장소 어댑터), (1.7) cross-check.ts·facts.ts(순수)
│   ├── sources/              # ProductSource 인터페이스 + 어댑터: yes24.ts, coupang-link.ts(1.3)
│   ├── llm/                  # prompt.ts(순수), body-generator.ts(Anthropic 호출·zod 검증), cost.ts, usage.ts
│   └── publish/              # publisher.ts(인터페이스), orchestrator.ts, handoff.ts, naver.ts(순수 어댑터·HTML 렌더), naver-style.ts(1.7 서식 토큰·템플릿·이모지 풀 — 스타일의 유일한 위치), naver-playwright.ts(브라우저·화면 지식), renderer.ts
└── data/dolsoe.db            # 런타임 생성 (.gitignore)
```
- 순수 로직(번갈아 선택, 중복 제외 필터, 품질 검사, 상태 전이 판정, 렌더링)은 I/O와 분리해 **순수 함수**로 둔다 → 테스트 용이.
- `bot/`은 `draft/`·`publish/`를 호출할 뿐, SQL을 직접 쓰지 않는다(`db.ts`만 SQL). 플랫폼(네이버) 지식은 `publish/naver.ts`·`naver-playwright.ts` 밖으로 새지 않는다(P3).
- 외부 호출(LLM·상품 소스·텔레그램·네이버)은 각 모듈 경계에서 zod로 검증한 뒤 도메인 타입으로 넘긴다.

## 5. DTO·데이터 흐름
- LLM 응답, 텔레그램 콜백·메시지, 상품 소스 응답, 발행 결과는 반드시 계약 스키마로 **경계에서 검증**한다. 미검증 데이터가 안으로 흐르지 않는다.
- SQLite row ↔ 도메인 매핑은 `src/db.ts` 한 곳에서만 한다.
- **구매 링크·대가성 문구는 LLM 출력이 아니라 렌더러가 `products`와 `DISCLOSURE_TEXTS`로 붙인다**(REQ-010, LLM이 누락·변조할 수 없게).

## 6. 에러·상태
- 초안 상태 전이는 반드시 `draft/` 전이 함수 하나를 거친다: `UPDATE … WHERE id=? AND status=?`의 변경 행 수 0이면 이미 처리된 것 → 조용히 무시(더블탭, REQ-009). `DRAFT_TRANSITIONS`에 없는 전이는 예외.
- 발행은 `publish_attempts`를 **먼저** 기록한 뒤 시도(ADR-006). 결과가 불확실하면 자동 재발행하지 않고 `failed` + 사람 확인 요청.
- **CAS로 중간 상태(`drafting`·`publishing`)에 진입한 뒤에는 어떤 예외 경로도 그 상태에 남기지 않는다**: 본문 전체를 감싸 예외 시 `failed`(또는 원래 대기 상태)로 되돌리고 알린다. 그래도 죽는 경우를 위해 기동 시 복구(`recoverStuckDrafts`·`recoverStuckPublishing`)를 둔다(1.3 수정 고착·1.4 발행 고착에서 반복 지적).
- 외부 전송 실패를 `retryable`로 분류할 때는 **상대가 명확히 거절한 경우만** 재시도 가능으로 본다. 네트워크 오류·타임아웃·5xx는 이미 처리됐을 수 있어 자동 재시도 금지(중복 발행·전달 방지, ADR-006).
- **"올라갔는지 모르는" 결과는 폴백하지 않는다**: 외부에 쓰기를 시도한 뒤 완료를 확인하지 못했으면(저장 버튼 클릭 후 미확인 등) 확정 실패로 바꿔 다음 단계로 내려가지 말고 던져서 `failed` + 사람 확인으로 멈춘다 — 폴백하면 중복 글이 생긴다(1.5 audit M1).
- **스타일은 `naver-style.ts` 밖에 없다(P3, ADR-011)**: 글자 크기·색·HTML·이모지는 계약·LLM 출력·`draft/`에 두지 않는다. 본문은 의미 단위만 담는다.
- **"확인됐는가"의 판정은 코드가 한다(ADR-013)**: 필사 문구·스펙처럼 외부에서 찾은 사실은 모델이 후보를 내고 `crossCheck`가 서로 다른 사이트 2곳의 원문 발췌에서 글자 그대로 확인한 것만 쓴다. 모델이 스스로 확인했다고 믿지 않는다. 검사 제외는 출처가 추적되는 구간(사용자 메모, 검증된 인용문)이고 **원본과 글자 그대로 같을 때만**이다(ADR-012).
- **외부 화면에 넣은 결과는 입력이 아니라 실제 화면에서 검증한다**: 대가성 문구 같은 필수 요소는 입력 문자열이 아니라 에디터에 실제로 들어간 텍스트에서 확인한 뒤에만 저장한다. 외부 호출(브라우저 등) 전체에는 데드라인을 걸어 매달려도 `publishing` 고착·핸들러 블로킹이 없게 한다(`withDeadline`, 1.5 audit M2·M3).
- 데이터 유실 금지: 초안·사용자 입력 원문(수정 지시·경험 문장)은 어떤 실패에서도 잃지 않는다.
- 실패는 조용히 묻지 않는다: 생성·발행·인증 실패는 텔레그램으로 알린다(NFR-004). 알림 자체가 실패하면 로그에 남긴다.
- **저장 후 외부 전송이 실패해도 초안이 고아가 되면 안 된다**: 초안 저장 → 카드 전송 경로는 `deliverCardSafely`를 거쳐 실패를 번호와 함께 알린다. 처리 도중 죽을 수 있는 중간 상태(`drafting`)는 기동 시 복구(`recoverStuckDrafts`)가 있어야 한다.
- **LLM을 부르는 모든 경로(일일·링크·수정)는 월 비용 상한 가드를 거친다**(NFR-001). 새 경로를 만들 때 `isBudgetExceeded` 확인을 빼먹지 않는다.
- 대기 상태(예: 수정 대기)는 사용자 입력을 삼키지 않는다: 대상이 이미 처리됐거나 다른 입력(링크)이 오면 이유를 알리거나 대기를 푼다.
- 사용자향 문구(텔레그램 메시지)는 한국어, 로그·식별자·커밋은 영어 식별자 + 한국어 설명 가능.

## 7. import 순서
외부 패키지 → `docs/contract` → `src/` 내부 상대 경로. 그룹 사이 빈 줄.

## 8. 테스트 (TDD)
- 이 프로젝트는 UI가 텔레그램뿐이라 백엔드 로직 전부 `(자동)` — 예외 없이 테스트 먼저(red→green). `(관통)`(REQ-012)는 실제 텔레그램·네이버로 종단 확인.
- 테스트 파일은 대상 옆 `*.test.ts`. **테스트 이름(`describe`/`it`)에 REQ ID 포함** → `gate.sh`가 `grep`으로 추적.
- 외부 API(Anthropic·텔레그램·YES24·쿠팡·네이버)는 테스트에서 모두 모킹한다. 실제 네트워크 호출을 하는 테스트는 만들지 않는다. 시간은 주입 가능한 `now()`로 받아 KST 경계를 테스트한다(NFR-002).

## 9. 주석
- "무엇"이 아니라 "왜". 비직관적 결정엔 관련 ADR을 한 줄로 링크.

## 10. 커밋 (사람 승인 필수)
- 커밋은 사용자 승인 후에만. 원자적. 메시지에 관련 REQ ID. 승인 요청은 `REQ | 변경 내용` 표로.

## 11. launchd 관련 (ADR-002)
- plist의 Node 실행 경로는 절대 경로로 하드코딩된다. Node 버전을 바꾸면 `~/Library/LaunchAgents/*.dolsoe.*.plist`도 갱신한다. 맥 절전 방지(`pmset`/`caffeinate`) 설정은 운영 절차로 build에서 정리.
