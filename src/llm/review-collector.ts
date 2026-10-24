import type Anthropic from "@anthropic-ai/sdk";

import type { Product } from "@contract/domain.js";
import { LLM_MODEL_REVIEW, REVIEW_NOTES_MAX_CHARS, REVIEW_SEARCH_MAX_USES, REVIEW_SOURCES_MAX, YES24_HOST_SUFFIX } from "@contract/domain.js";

import { dropCopiedSentences } from "../draft/quality-check.js";
import type { ReviewCollector, ReviewEvidence } from "../draft/review.js";

import type { LlmUsageReport } from "./body-generator.js";
import { collectCitations, collectExcerpts, collectNotes, collectResultUrls, isHttpUrl, runWebSearch, unique } from "./web-search.js";

const REVIEW_SYSTEM = `당신은 한국어 책 후기 조사원입니다. 웹검색으로 이 책에 대한 독자 후기·서평을 찾아 아래 규칙대로 정리합니다.

1. 한국어 독자 후기·서평(블로그, 서점 서평 등)만 근거로 삼습니다. 찾지 못하면 "후기를 찾지 못했습니다"라고만 답합니다.
2. 후기 문장을 그대로 옮기지 않고 의역합니다. 큰따옴표 인용과 후기 원문 문장 복사는 금지입니다.
3. 후기 작성자의 1인칭 경험("나는 읽고…")을 내 경험처럼 쓰지 않고 "독자들은 ~라고 느꼈다"처럼 3인칭으로 정리합니다.
4. 후기에서 확인되지 않은 내용(줄거리 세부, 장면, 인물)은 지어내지 않습니다. 확인된 것만 씁니다.
5. 출처 URL이나 사이트 이름은 쓰지 않습니다(출처는 시스템이 따로 기록합니다).
6. 아래 항목을 한 줄씩, 확인된 것만 씁니다:
- 분위기·읽는 느낌:
- 많이 언급된 인상 깊은 대목:
- 이런 독자에게 맞다는 평:
- 아쉽다는 평:`;

export function buildReviewPrompt(product: Product): { system: string; user: string } {
  const author = product.specs["저자"];
  const lines = [`책: 《${product.title}》`, ...(author === undefined ? [] : [`저자: ${author}`])];
  return { system: REVIEW_SYSTEM, user: `${lines.join("\n")}\n\n이 책의 독자 후기·서평을 검색해 정리해 주세요.` };
}

/**
 * 출처: 노트에 실제 인용된 URL(= "참고한 후기"). 인용이 없으면 출처도 없다 — 검색에 걸렸을 뿐인 페이지(쇼핑몰 등)를 근거로 세지 않는다.
 * 인용 URL은 검색 결과 안에 있던 것만 인정한다(지어낸 URL 방지).
 */
function collectSources(blocks: Parameters<typeof collectCitations>[0]): string[] {
  const results = new Set(collectResultUrls(blocks));
  const cited = collectCitations(blocks).flatMap((citation) => (isHttpUrl(citation.url) && results.has(citation.url) ? [citation.url] : []));
  return unique(cited).slice(0, REVIEW_SOURCES_MAX);
}

/**
 * REQ-016 / ADR-010: Anthropic 웹검색으로 독자 후기를 모아 의역 노트로 받는다.
 * 출처 URL은 모델 출력이 아니라 검색 결과 블록에서 직접 가져온다(지어낸 URL 방지). 출처가 하나도 없으면 노트도 근거로 쓰지 않는다.
 */
export function createReviewCollector(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
}): ReviewCollector {
  return {
    async collect(product: Product): Promise<ReviewEvidence> {
      const { system, user } = buildReviewPrompt(product);
      const blocks = await runWebSearch({
        client: options.client,
        onUsage: options.onUsage,
        model: LLM_MODEL_REVIEW,
        system,
        user,
        maxUses: REVIEW_SEARCH_MAX_USES,
        // YES24 후기 페이지는 약관·robots상 쓰지 않는다(ADR-010). 검색 단계에서 아예 뺀다.
        blockedDomains: [YES24_HOST_SUFFIX],
        refusalMessage: "모델이 후기 수집 요청을 거절했습니다",
      });

      const sources = collectSources(blocks);
      if (sources.length === 0) return { notes: "", sources: [] };
      const excerpts = collectExcerpts(blocks);
      // 수집 모델이 후기 문장을 베껴 쓴 부분은 노트에서 버린다 — 생성 모델이 그걸 다시 베끼기 전에 막는다(REQ-016).
      const notes = dropCopiedSentences(collectNotes(blocks), excerpts).slice(0, REVIEW_NOTES_MAX_CHARS).trimEnd();
      if (notes.length === 0) return { notes: "", sources: [] };
      return { notes, sources, ...(excerpts.length > 0 ? { excerpts } : {}) };
    },
  };
}
