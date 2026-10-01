# ADR-001: TypeScript(strict) + Node 22 + vitest/eslint

- 날짜: 2026-09-30 · 상태: 채택됨

## 맥락
1인 운영 봇. 사용자가 TypeScript·grammY·zod에 이미 익숙하고 jipsa에서 같은 스택이 검증됨. 계약(zod)으로 경계를 못 박는 워크플로우와 잘 맞음.

## 결정
TypeScript strict, Node 22, `tsx` 실행, `vitest`, `eslint`(typescript-eslint), zod 계약. `@anthropic-ai/sdk`는 신규 프로젝트에서 **최신 버전**으로 시작(jipsa의 0.32는 오래됨 — 호환성은 build 1.1에서 확인).

## 이유
학습·운영 비용 0, jipsa 자산(package.json 세트·CONVENTIONS·테스트 규약) 재사용.

## 버린 대안
Python(사용자 스택과 다름, 계약 공유 이점 없음), Deno/Bun(새 도구 학습 비용).

## 결과/트레이드오프
jipsa 의존성을 그대로 복사하지 않고 필요한 것만(cheerio·rss-parser는 필요 시 추가).

## 디버깅 노트
- 2026-09-30 build 1.1: 신규 설치가 jipsa 때보다 메이저가 올라감(zod 4, TypeScript 6, ESLint 10, vitest 5, better-sqlite3 13). 계약이 zod 4에서 `z.record(z.string())`(인자 1개)로 타입 에러 → `z.record(z.string(), z.string())`로 수정(필드 모양 불변). 나머지 스키마(discriminatedUnion·`.datetime()`·`.url()`)는 런타임 재검증 통과. ESLint 10에서도 기존 flat config가 그대로 동작.
