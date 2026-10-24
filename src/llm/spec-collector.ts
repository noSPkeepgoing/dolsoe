import type Anthropic from "@anthropic-ai/sdk";

import type { Product } from "@contract/domain.js";
import { LLM_MODEL_REVIEW, SPEC_SEARCH_MAX_USES } from "@contract/domain.js";

import type { SpecCollector, SpecEvidence } from "../draft/spec.js";

import type { LlmUsageReport } from "./body-generator.js";
import { collectEvidence, collectNotes, runWebSearch } from "./web-search.js";

const SPEC_SYSTEM = `당신은 가전제품 스펙 조사원입니다. 웹검색으로 제조사·쇼핑·리뷰 사이트에서 아래 상품의 요청된 스펙 항목을 찾습니다.

1. 사이트에 적힌 값을 그대로 옮깁니다(단위 포함, 예: 3.5L). 환산·추정·계산을 하지 않습니다.
2. 서로 다른 사이트 2곳 이상에서 같은 값으로 확인되는 항목만 쓰고, 항목마다 확인한 사이트를 모두 인용합니다. 하나라도 확신이 없으면 그 항목은 쓰지 않습니다.
3. 쿠팡 페이지는 열지 않습니다. 비슷한 다른 모델의 값을 섞지 않습니다.
4. 출력은 "항목: 값" 형식으로 한 줄에 하나만, 다른 설명 없이 씁니다. 찾지 못한 항목은 줄 자체를 쓰지 않습니다.`;

export function buildSpecPrompt(product: Product, keys: readonly string[]): { system: string; user: string } {
  return { system: SPEC_SYSTEM, user: `상품: ${product.title}\n찾을 항목: ${keys.join(", ")}\n\n이 상품의 위 항목을 검색해 주세요.` };
}

/** "용량: 3.5L" 줄들 → 후보. 요청하지 않은 항목과 형식이 다른 줄은 버린다. */
export function parseSpecLines(text: string, keys: readonly string[]): { key: string; value: string }[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*[-•*]?\s*([^:：]+?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    return key !== undefined && value !== undefined && keys.includes(key) ? [{ key, value }] : [];
  });
}

/**
 * REQ-028 / ADR-013: 웹검색으로 스펙 후보를 모으고, 인용된 원문 조각(+URL)을 근거로 함께 돌려준다.
 * 2곳 이상 확인 여부는 여기서 판정하지 않는다(draft/spec.ts의 `confirmSpecs`가 한다). 출처 URL은 검색 결과에 있던 것만 인정한다.
 */
export function createSpecCollector(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
}): SpecCollector {
  return {
    async collect(product: Product, keys: readonly string[]): Promise<SpecEvidence> {
      const { system, user } = buildSpecPrompt(product, keys);
      const blocks = await runWebSearch({
        client: options.client,
        onUsage: options.onUsage,
        model: LLM_MODEL_REVIEW,
        system,
        user,
        maxUses: SPEC_SEARCH_MAX_USES,
        blockedDomains: ["coupang.com"],
        refusalMessage: "모델이 스펙 수집 요청을 거절했습니다",
      });
      return { candidates: parseSpecLines(collectNotes(blocks), keys), evidence: collectEvidence(blocks) };
    },
  };
}
