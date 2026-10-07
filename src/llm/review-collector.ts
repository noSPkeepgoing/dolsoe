import type Anthropic from "@anthropic-ai/sdk";

import type { Product } from "@contract/domain.js";
import { LLM_MODEL_REVIEW, REVIEW_SEARCH_MAX_USES, REVIEW_SOURCES_MAX, YES24_HOST_SUFFIX } from "@contract/domain.js";

import type { ReviewCollector, ReviewEvidence } from "../draft/review.js";

import { LlmRefusalError, type LlmUsageReport } from "./body-generator.js";

/** 사고 토큰도 이 한도에 포함된다. 검색 결과 요약만 받으므로 본문 생성보다 작게 둔다. */
const REVIEW_MAX_TOKENS = 8_000;
/** `pause_turn`(서버 도구 반복 한도)일 때 이어 호출하는 최대 횟수. */
const MAX_CONTINUATIONS = 3;

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

/** 응답 콘텐츠 블록을 모양이 달라져도 안 터지게 느슨하게 읽는다(서버 도구 블록은 SDK 타입이 자주 바뀐다). */
interface LooseBlock {
  type?: string;
  text?: string;
  content?: unknown;
  citations?: unknown;
}

interface LooseCitation {
  type?: string;
  url?: unknown;
  cited_text?: unknown;
}

const isHttpUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value);

/** 마지막 검색 결과 뒤의 블록들 — 모델이 정리해 쓴 글(검색 중간의 혼잣말은 제외). */
const afterLastSearch = (blocks: readonly LooseBlock[]): LooseBlock[] =>
  blocks.slice(blocks.map((block) => block.type).lastIndexOf("web_search_tool_result") + 1);

/** 노트에 실제로 달린 인용(웹검색은 항상 인용을 붙인다). 검색에 걸렸을 뿐인 페이지는 포함하지 않는다. */
function collectCitations(blocks: readonly LooseBlock[]): LooseCitation[] {
  return afterLastSearch(blocks).flatMap((block) =>
    block.type === "text" && Array.isArray(block.citations)
      ? (block.citations as LooseCitation[]).filter((citation) => citation.type === "web_search_result_location")
      : [],
  );
}

/** 검색 결과 블록의 URL. 오류 객체(content가 배열이 아님)와 http(s)가 아닌 URL은 버린다. */
function collectResultUrls(blocks: readonly LooseBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "web_search_tool_result" && Array.isArray(block.content)
      ? (block.content as { url?: unknown }[]).flatMap((result) => (isHttpUrl(result.url) ? [result.url] : []))
      : [],
  );
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * 출처: 노트에 실제 인용된 URL(= "참고한 후기"). 인용이 하나도 없으면 검색 결과 URL로 대신한다.
 * 인용 URL은 검색 결과 안에 있던 것만 인정한다(지어낸 URL 방지).
 */
function collectSources(blocks: readonly LooseBlock[]): string[] {
  const results = new Set(collectResultUrls(blocks));
  const cited = unique(collectCitations(blocks).flatMap((citation) => (isHttpUrl(citation.url) && results.has(citation.url) ? [citation.url] : [])));
  return (cited.length > 0 ? cited : [...results]).slice(0, REVIEW_SOURCES_MAX);
}

/** 인용 단위로 쪼개진 텍스트 블록을 그대로 이어 붙여 정리글을 복원한다. */
const collectNotes = (blocks: readonly LooseBlock[]): string =>
  afterLastSearch(blocks)
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("")
    .trim();

/** 후기 원문 조각(cited_text, 최대 150자 안팎). 본문이 후기 문장을 그대로 옮겼는지 대조하는 용도로만 쓴다. */
const collectExcerpts = (blocks: readonly LooseBlock[]): string[] =>
  unique(collectCitations(blocks).flatMap((citation) => (typeof citation.cited_text === "string" && citation.cited_text.trim().length > 0 ? [citation.cited_text.trim()] : [])));

/**
 * REQ-016 / ADR-010: Anthropic 웹검색(기본형 web_search_20250305 — 동적 필터링의 코드 실행 비용을 피한다)으로 독자 후기를 모아 의역 노트로 받는다.
 * 출처 URL은 모델 출력이 아니라 검색 결과 블록에서 직접 가져온다(지어낸 URL 방지). 출처가 하나도 없으면 노트도 근거로 쓰지 않는다.
 * 사용량(토큰 + 웹검색 횟수)은 결과 판정 전에 먼저 보고한다 — 거절·빈 결과도 과금된다.
 */
export function createReviewCollector(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
}): ReviewCollector {
  return {
    async collect(product: Product): Promise<ReviewEvidence> {
      const { system, user } = buildReviewPrompt(product);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      const blocks: LooseBlock[] = [];

      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        const response = await options.client.messages.create({
          model: LLM_MODEL_REVIEW,
          max_tokens: REVIEW_MAX_TOKENS,
          system,
          messages,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: REVIEW_SEARCH_MAX_USES,
              // YES24 후기 페이지는 약관·robots상 쓰지 않는다(ADR-010). 검색 단계에서 아예 뺀다.
              blocked_domains: [YES24_HOST_SUFFIX],
              user_location: { type: "approximate", country: "KR" },
            },
          ],
        });

        options.onUsage({
          model: LLM_MODEL_REVIEW,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          webSearchRequests: response.usage.server_tool_use?.web_search_requests ?? 0,
        });

        if (response.stop_reason === "refusal") throw new LlmRefusalError("모델이 후기 수집 요청을 거절했습니다");
        blocks.push(...(response.content as LooseBlock[]));
        if (response.stop_reason !== "pause_turn") break;
        // 서버 도구 반복 한도에 걸려 멈춘 것 — 응답을 그대로 이어 보내면 서버가 거기서부터 계속한다("계속해줘" 메시지를 덧붙이지 않는다).
        messages.push({ role: "assistant", content: response.content });
      }

      const sources = collectSources(blocks);
      if (sources.length === 0) return { notes: "", sources: [] };
      const excerpts = collectExcerpts(blocks);
      return { notes: collectNotes(blocks), sources, ...(excerpts.length > 0 ? { excerpts } : {}) };
    },
  };
}
