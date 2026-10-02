import { describe, expect, it } from "vitest";

import { MONTHLY_LLM_BUDGET_KRW, USD_TO_KRW } from "@contract/domain.js";

import { estimateCostKrw, isBudgetExceeded } from "./cost.js";

describe("estimateCostKrw", () => {
  it("[NFR-001] Sonnet 5.5: 입력 100만 + 출력 100만 토큰 = ($2+$10) × 환율", () => {
    expect(estimateCostKrw("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      12 * USD_TO_KRW,
    );
  });

  it("[NFR-001] 캐시 읽기 토큰은 입력 단가가 아니라 캐시 읽기 단가로 센다", () => {
    expect(
      estimateCostKrw("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(0.2 * USD_TO_KRW);
  });

  it("[NFR-001] 모르는 모델이면 비용을 지어내지 않고 오류", () => {
    expect(() => estimateCostKrw("some-unknown-model", { inputTokens: 1, outputTokens: 1 })).toThrow(/unknown model/i);
  });
});

describe("isBudgetExceeded", () => {
  it("[NFR-001] 월 누적 비용이 상한 이상이면 true", () => {
    expect(isBudgetExceeded(MONTHLY_LLM_BUDGET_KRW - 1)).toBe(false);
    expect(isBudgetExceeded(MONTHLY_LLM_BUDGET_KRW)).toBe(true);
  });
});
