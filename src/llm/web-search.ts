import type Anthropic from "@anthropic-ai/sdk";

import { LlmRefusalError, type LlmUsageReport } from "./body-generator.js";

/** 사고 토큰도 이 한도에 포함된다. 검색 결과 요약만 받으므로 본문 생성보다 작게 둔다. */
const SEARCH_MAX_TOKENS = 8_000;
/** `pause_turn`(서버 도구 반복 한도)일 때 이어 호출하는 최대 횟수. */
const MAX_CONTINUATIONS = 3;

/** 응답 콘텐츠 블록을 모양이 달라져도 안 터지게 느슨하게 읽는다(서버 도구 블록은 SDK 타입이 자주 바뀐다). */
export interface LooseBlock {
  type?: string;
  text?: string;
  content?: unknown;
  citations?: unknown;
}

export interface LooseCitation {
  type?: string;
  url?: unknown;
  cited_text?: unknown;
}

/** 파싱되는 http(s) URL만. 모양만 비슷한 깨진 URL은 계약(`z.string().url()`)에서 초안 읽기를 깨뜨리므로 여기서 거른다. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === "http:" || protocol === "https:") && hostname.length > 0;
  } catch {
    return false;
  }
}

/** 마지막 검색 결과 뒤의 블록들 — 모델이 정리해 쓴 글(검색 중간의 혼잣말은 제외). */
export const afterLastSearch = (blocks: readonly LooseBlock[]): LooseBlock[] =>
  blocks.slice(blocks.map((block) => block.type).lastIndexOf("web_search_tool_result") + 1);


/** 노트에 실제로 달린 인용(웹검색은 항상 인용을 붙인다). 검색에 걸렸을 뿐인 페이지는 포함하지 않는다. */
export function collectCitations(blocks: readonly LooseBlock[]): LooseCitation[] {
  return afterLastSearch(blocks).flatMap((block) =>
    block.type === "text" && Array.isArray(block.citations)
      ? (block.citations as LooseCitation[]).filter((citation) => citation.type === "web_search_result_location")
      : [],
  );
}

/** 검색 결과 블록의 URL. 오류 객체(content가 배열이 아님)와 http(s)가 아닌 URL은 버린다. */
export function collectResultUrls(blocks: readonly LooseBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "web_search_tool_result" && Array.isArray(block.content)
      ? (block.content as { url?: unknown }[]).flatMap((result) => (isHttpUrl(result.url) ? [result.url] : []))
      : [],
  );
}

export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** 인용 단위로 쪼개진 텍스트 블록을 그대로 이어 붙여 정리글을 복원한다. */
export const collectNotes = (blocks: readonly LooseBlock[]): string =>
  afterLastSearch(blocks)
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("")
    .trim();

/** 인용된 원문 조각(cited_text, 최대 150자 안팎) 중복 없이. */
export const collectExcerpts = (blocks: readonly LooseBlock[]): string[] =>
  unique(collectCitations(blocks).flatMap((citation) => (typeof citation.cited_text === "string" && citation.cited_text.trim().length > 0 ? [citation.cited_text.trim()] : [])));

/** 인용별 (URL, 원문 조각). URL은 검색 결과 안에 있던 것만 인정한다(지어낸 URL 방지). 교차 확인(cross-check)의 재료다. */
export function collectEvidence(blocks: readonly LooseBlock[]): { url: string; excerpt: string }[] {
  const results = new Set(collectResultUrls(blocks));
  return collectCitations(blocks).flatMap((citation) =>
    isHttpUrl(citation.url) && results.has(citation.url) && typeof citation.cited_text === "string" && citation.cited_text.trim().length > 0
      ? [{ url: citation.url, excerpt: citation.cited_text.trim() }]
      : [],
  );
}

/**
 * 웹검색(기본형 web_search_20250305 — 동적 필터링의 코드 실행 비용을 피한다) 한 번의 조사. 이어 호출(pause_turn)을 합산해 `maxUses`를 총 상한으로 지킨다(비용).
 * 사용량(토큰 + 웹검색 횟수)은 결과 판정 전에 먼저 보고한다 — 거절·빈 결과도 과금된다. 응답 블록 전체를 돌려주고 해석은 호출 쪽이 한다.
 */
export async function runWebSearch(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
  model: string;
  system: string;
  user: string;
  maxUses: number;
  blockedDomains?: readonly string[];
  refusalMessage: string;
}): Promise<LooseBlock[]> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.user }];
  const blocks: LooseBlock[] = [];
  let searches = 0;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const response = await options.client.messages.create({
      model: options.model,
      max_tokens: SEARCH_MAX_TOKENS,
      system: options.system,
      messages,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: options.maxUses,
          ...(options.blockedDomains === undefined ? {} : { blocked_domains: [...options.blockedDomains] }),
          user_location: { type: "approximate", country: "KR" },
        },
      ],
    });

    const searchesThisCall = response.usage.server_tool_use?.web_search_requests ?? 0;
    searches += searchesThisCall;
    options.onUsage({
      model: options.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      webSearchRequests: searchesThisCall,
    });

    if (response.stop_reason === "refusal") throw new LlmRefusalError(options.refusalMessage);
    blocks.push(...(response.content as LooseBlock[]));
    // `max_uses`는 요청당 한도라 이어 호출마다 새로 시작된다 — 총합이 상한에 닿으면 더 부르지 않는다(비용 상한).
    if (response.stop_reason !== "pause_turn" || searches >= options.maxUses) break;
    // 서버 도구 반복 한도에 걸려 멈춘 것 — 응답을 그대로 이어 보내면 서버가 거기서부터 계속한다("계속해줘" 메시지를 덧붙이지 않는다).
    messages.push({ role: "assistant", content: response.content });
  }
  return blocks;
}
