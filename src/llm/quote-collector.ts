import type Anthropic from "@anthropic-ai/sdk";

import type { Product } from "@contract/domain.js";
import { LLM_MODEL_REVIEW, QUOTE_MAX_CHARS, QUOTE_SEARCH_MAX_USES, YES24_HOST_SUFFIX } from "@contract/domain.js";

import type { QuoteCollector, QuoteEvidence } from "../draft/quote.js";

import type { LlmUsageReport } from "./body-generator.js";
import { collectEvidence, collectNotes, runWebSearch } from "./web-search.js";

const QUOTE_SYSTEM = `당신은 책 속 문장 조사원입니다. 웹검색으로 독자들이 필사하거나 즐겨 인용하는 이 책의 문장을 찾습니다.

1. 사이트에 적힌 문장을 한 글자도 바꾸지 않고 그대로 옮깁니다. 요약·의역·합성·기억에서 꺼낸 문장은 쓰지 않습니다.
2. 한두 문장, ${QUOTE_MAX_CHARS}자 이내의 문장만 씁니다.
3. 서로 다른 사이트 2곳 이상에 같은 문장이 있을 때만 쓰고, 그 사이트들을 모두 인용합니다. 확신이 없으면 쓰지 않습니다.
4. 출력은 "- 문장" 형식으로 한 줄에 하나씩, 최대 3개, 다른 설명 없이 씁니다. 찾지 못하면 아무것도 쓰지 않습니다.`;

export function buildQuotePrompt(product: Product): { system: string; user: string } {
  const author = product.specs["저자"];
  const lines = [`책: 《${product.title}》`, ...(author === undefined ? [] : [`저자: ${author}`])];
  return { system: QUOTE_SYSTEM, user: `${lines.join("\n")}\n\n이 책에서 독자들이 많이 필사하거나 인용하는 문장을 검색해 주세요.` };
}

const WRAPPING = /^["“”'‘’「『]+|["“”'‘’」』]+$/g;

/** "- 문장" 줄들 → 후보(감싼 따옴표만 뗀다). 글자는 그대로 두어야 교차 확인이 의미가 있다. */
export function parseQuoteLines(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*[-•*]\s*(.+?)\s*$/.exec(line);
    const candidate = match?.[1]?.replace(WRAPPING, "").trim();
    return candidate === undefined || candidate.length === 0 ? [] : [candidate];
  });
}

/**
 * REQ-029 / ADR-013: 웹검색으로 필사 문구 후보를 모으고 인용된 원문 조각(+URL)을 근거로 함께 돌려준다.
 * 2곳 확인 여부는 여기서 판정하지 않는다(draft/quote.ts의 `pickWebQuote`가 한다). YES24는 약관·robots상 검색에서 뺀다(ADR-010).
 */
export function createQuoteCollector(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
}): QuoteCollector {
  return {
    async collect(product: Product): Promise<QuoteEvidence> {
      const { system, user } = buildQuotePrompt(product);
      const blocks = await runWebSearch({
        client: options.client,
        onUsage: options.onUsage,
        model: LLM_MODEL_REVIEW,
        system,
        user,
        maxUses: QUOTE_SEARCH_MAX_USES,
        blockedDomains: [YES24_HOST_SUFFIX],
        refusalMessage: "모델이 필사 문구 수집 요청을 거절했습니다",
      });
      return { candidates: parseQuoteLines(collectNotes(blocks)), evidence: collectEvidence(blocks) };
    },
  };
}
