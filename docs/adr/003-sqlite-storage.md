# ADR-003: SQLite(WAL, better-sqlite3) 단일 파일

- 날짜: 2026-09-30 · 상태: 채택됨

## 맥락
초안·상태·발행 이력·중복 제외 기록·처리한 텔레그램 update·LLM 사용량·스케줄 잡을 저장. 1인·하루 1편.

## 결정
`data/dolsoe.db`(gitignore), WAL, 동기 API(better-sqlite3). 스키마는 PLAN.md, 도메인 타입은 `docs/contract/domain.ts`와 1:1. row↔도메인 매핑은 `src/db.ts` 한 곳.

## 이유
서버·비용 0, 단일 프로세스(ADR-002)라 동시성 문제 없음. 상태 전이는 트랜잭션+조건부 UPDATE(compare-and-swap)로 멱등 처리.

## 버린 대안
Postgres/클라우드 DB(과설계), JSON 파일(트랜잭션·중복 방어 부재).

## 결과/트레이드오프
맥 디스크 = 유일한 저장소. 일 1회 파일 복사 백업은 build에서 결정(YAGNI로 P2 후보).
