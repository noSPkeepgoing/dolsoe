import { LLM_PRICING_USD_PER_MTOK, MONTHLY_LLM_BUDGET_KRW, USD_TO_KRW, WEB_SEARCH_USD_PER_REQUEST } from "@contract/domain.js";

type PricedModel = keyof typeof LLM_PRICING_USD_PER_MTOK;

const isPricedModel = (model: string): model is PricedModel => model in LLM_PRICING_USD_PER_MTOK;

/** NFR-001·ADR-007: 사용량 → 추정 원화. 모르는 모델이면 비용을 지어내지 않고 실패한다. */
export function estimateCostKrw(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; webSearchRequests?: number },
): number {
  if (!isPricedModel(model)) throw new Error(`Unknown model for pricing: ${model}`);
  const price = LLM_PRICING_USD_PER_MTOK[model];
  const usd =
    (usage.inputTokens * price.input + usage.outputTokens * price.output + (usage.cacheReadTokens ?? 0) * price.cacheRead) /
      1_000_000 +
    (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD_PER_REQUEST;
  return usd * USD_TO_KRW;
}

export function isBudgetExceeded(monthCostKrw: number): boolean {
  return monthCostKrw >= MONTHLY_LLM_BUDGET_KRW;
}
