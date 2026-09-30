# 돌쇠 (dolsoe)

텔레그램 승인형 블로그 수익화 자동화. 워크플로우: `/kickoff → /architect → /build → /audit → 커밋(■ 승인)`.

## 세션 시작 시 (자동)
1. `docs/PLAN.md` 상단 **"진행 상태" 원장**을 읽고 현재·다음 액션·블로커를 사용자에게 한 줄로 알린다.
2. `git log --oneline -5`로 원장과 교차확인한다(완료의 진실은 git).
3. `git status --short`로 `docs/` 미커밋 변경이 있는지 확인한다.
(아직 git 미초기화면 그 사실만 알린다.)

## 규칙 요약
- 산출물: `docs/PRD.md`, `docs/adr/`, `docs/contract/domain.ts`(zod, 유일한 진실), `docs/PLAN.md`, `docs/CONVENTIONS.md`, `scripts/gate.sh`.
- 커밋은 항상 사용자 승인 후, REQ 표로 요약. ✅ 완료 서브페이즈를 다시 건드릴 땐 먼저 확인.
- 이 프로젝트에서 OMC는 쓰지 않는다(자체 킷만).
