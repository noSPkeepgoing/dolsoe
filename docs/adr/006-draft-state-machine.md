# ADR-006: 초안 상태머신 + 조건부 UPDATE 멱등 전이

- 날짜: 2026-09-30 · 상태: 채택됨

## 맥락
발행 더블탭(REQ-009), 애매한 발행 실패(타임아웃 후 실제로는 발행됨), 수정 중 발행 경합.

## 결정
상태: `drafting → awaiting_approval → publishing → published | handed_off | failed`, 그리고 `discarded`. 전이는 `UPDATE … WHERE id=? AND status=?`의 변경 행 수로 판정(compare-and-swap). `publishing`은 시도 기록(`publish_attempts`)을 먼저 쓴 뒤 진입. 결과가 불확실하면 `failed`로 두고 사람에게 확인 요청(자동 재발행 금지, 1회 재시도는 명확한 실패에 한함 — REQ-013).

## 이유
잠금·큐 없이 SQL 한 줄로 멱등. 단일 프로세스(ADR-002)라 충분.

## 버린 대안
인메모리 락(재기동 시 소실), 외부 큐(과설계).

## 결과/트레이드오프
"확인 필요" 상태는 사람이 풀어야 함.
