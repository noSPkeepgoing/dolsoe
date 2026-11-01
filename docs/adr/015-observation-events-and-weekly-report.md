# ADR-015: 관측 — 추가 전용 이벤트 로그 + 주간 리포트 잡 + `/수익` 입력 + 자동 발행 배지

- 날짜: 2026-11-01 · 상태: 채택됨 (PRD §12 REQ-021·024 단계 A)

## 맥락
"수정 없이 승인 비율"과 "최근 10편 중 폐기 수"를 세야 하는데 `drafts`에는 `updated_at`뿐이라 승인 시각·수정 여부를 알 수 없다. 수익은 외부 대시보드를 긁지 않고 사용자가 입력한다(PRD 결정).

## 결정
- **DB v7(추가만)**: `draft_events(id, draft_id NULL, category NULL, kind, at)` — kind는 `created / body_revised / approved / discarded / generation_skipped`(계약 `DraftEventKindSchema`). `weekly_income(week_start PK, coupang_krw, adpost_krw, updated_at)`, `trend_days(date PK, used, reason)`(ADR-017). 이벤트 `INDEX(kind, at)`·`INDEX(draft_id)`.
- **기록 지점**: `created`=초안 저장 시, `approved`=발행이 `handed_off|published`로 **성공**한 전이(재시도해도 초안당 1회, `(draft_id,kind)` 중복 방지), `discarded`=폐기 CAS 성공, `generation_skipped`=기본 모드 건너뜀 알림을 보낼 때. **`body_revised`는 `수정` 지시에서 경험 한 줄·`문구:` 토큰을 뺀 나머지가 비어 있지 않을 때만** 남긴다. 메모·사진 첨부(REQ-034)는 이벤트를 남기지 않는다 → "수정"으로 세지 않는다(PRD 결정, 비평 반영).
- **백필 없음**: 옛 초안에는 수정 이력이 없어 "수정 없이 승인"을 알 수 없으므로 v7 이후부터 센다. 배지는 이벤트가 쌓여 최근 10편이 채워진 카테고리부터 켜진다(`not_enough_history`).
- **주간 리포트**: `schedule_jobs.kind='weekly_report'`, 일요일 20:00 KST(`WEEKLY_REPORT_*`)에 tick이 만든다. 집계는 `report/aggregate.ts` 순수 함수(이벤트+초안 상태 → `WeeklyReport`), 문장화는 카드 렌더러. 활동 0이어도 보낸다(NFR-004). 봇이 꺼져 있던 주는 켜질 때 **한 번만** 늦게 보낸다(읽기 전용 메시지라 EDGE-006의 "몰아서 생성"과 다름, 승인 부담 없음).
- **`/수익 <쿠팡> <애드포스트>`**: 원 단위 정수 두 개(`INCOME_MAX_KRW` 이하), 선택적으로 앞에 `지난주`. 기본은 지금이 속한 KST 월~일 주, 같은 주 재입력은 덮어쓴다. 형식이 틀리면 안내만.
- **자동 발행 배지(단계 A)**: `autoBadge(categoryHistory, checks)` 순수 함수 — 카테고리별 최근 `AUTO_BADGE_WINDOW`편 중 본문 수정 없이 승인 ≥ `AUTO_BADGE_MIN_CLEAN`, 폐기 ≤ `AUTO_BADGE_MAX_DISCARDED`, 이번 초안의 문체·유사도 검사 통과, 경험이 필수인 카테고리(맛집)는 제외. 카드 한 줄 표시일 뿐 동작은 바뀌지 않는다.

## 이유
이벤트 로그는 지표 정의가 바뀌어도(배지 기준 조정) 원자료를 다시 셀 수 있다. 상태 컬럼만으로는 "수정했다가 승인"과 "그냥 승인"을 구분할 수 없다.

## 버린 대안
`drafts`에 `revision_count` 컬럼(경험/본문 구분이 안 되고 시각도 없음), 로그 파일 파싱(구조화 안 됨), 쿠팡·애드포스트 대시보드 긁기(약관·세션 위험, PRD 비범위).

## 결과/트레이드오프
리포트 첫 주들은 수치가 적다(백필 없음). 이벤트 기록이 누락되면 지표가 어긋나므로 기록 지점은 상태 전이 함수 안에 둔다(호출부가 따로 기록하지 않음).
