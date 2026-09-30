# ADR-005: Publisher 어댑터 + Orchestrator 폴백 사다리, 첫 구현은 텔레그램 전달

- 날짜: 2026-09-30 · 상태: 채택됨

## 맥락
네이버 글쓰기 API의 2026년 현재 동작이 미확인(PRD Q1). 자료가 엇갈리고, 임시저장은 API 근거가 없음. 블로그 미개설. P3(발행부 분리), REQ-012·013.

## 결정
`Publisher` 인터페이스 `publish(post): PublishResult`(`mode: live|private|manual`, `retryable`, `authExpired`). 사다리(①live ②private ③manual)는 어댑터가 아니라 `PublishOrchestrator`가 우선순위 목록으로 순회하며 시도 로그를 남기고 알림에 처리 방식을 표시. **1차 구현은 ③ `TelegramHandoffPublisher`**(완성 본문을 텔레그램으로 전달, 내가 복붙). `NaverApiPublisher`는 블로그 개설 후 **스파이크(실호출 확인)** 결과에 따라 추가. 본문은 플랫폼 중립 구조체로 저장하고 렌더러는 어댑터 쪽. 대가성 문구 삽입·차단(REQ-010)은 어댑터 앞 공통 게이트.

## 이유
Q1 결과와 무관하게 구조가 안 바뀌고, ③만으로도 MVP 가치(승인 흐름·품질 검증)가 성립.

## 버린 대안
브라우저 자동화(약관·계정 정지 위험), 네이버 API 전제로 설계(미확인 리스크).

## 결과/트레이드오프
API가 안 되면 승인 뒤 복붙 한 단계가 사람 몫.
