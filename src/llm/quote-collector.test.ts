import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";

import { buildQuotePrompt, createQuoteCollector, parseQuoteLines } from "./quote-collector.js";

const product: Product = {
  externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "달의 정원", url: "https://www.yes24.com/addon/1",
  priceKrw: null, priceAsOf: null, specs: { 저자: "김서연" },
};

describe("parseQuoteLines", () => {
  it("[REQ-029] '- 문장' 줄만 읽고 감싼 따옴표만 뗀다(글자는 그대로)", () => {
    expect(parseQuoteLines('- “오늘도 애썼어요.”\n* 두 번째 문장이에요.\n설명하자면 이렇습니다\n-')).toEqual(["오늘도 애썼어요.", "두 번째 문장이에요."]);
  });
});

describe("createQuoteCollector", () => {
  it("[REQ-029] 인용된 원문 조각+URL을 근거로 후보를 돌려주고, YES24는 검색에서 빼며 사용량을 보고한다", async () => {
    const create = vi.fn(async () => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 3 } },
      content: [
        { type: "web_search_tool_result", content: [{ url: "https://a.example/1" }, { url: "https://b.example/1" }] },
        { type: "text", text: "- 오늘도 애썼어요.", citations: [
          { type: "web_search_result_location", url: "https://a.example/1", cited_text: "오늘도 애썼어요." },
          { type: "web_search_result_location", url: "https://b.example/1", cited_text: "“오늘도 애썼어요.”" },
        ] },
      ],
    }));
    const onUsage = vi.fn();
    const result = await createQuoteCollector({ client: { messages: { create } } as never, onUsage }).collect(product);
    expect(result.candidates).toEqual(["오늘도 애썼어요."]);
    expect(result.evidence).toHaveLength(2);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ webSearchRequests: 3 }));
    const request = (create.mock.calls[0] as unknown as [{ tools: { blocked_domains: string[] }[] }])[0];
    expect(request.tools[0]!.blocked_domains).toContain("yes24.com");
  });

  it("[REQ-029] 프롬프트에 책 제목과 저자가 들어가고 글자 그대로·2곳 규칙이 있다", () => {
    const { system, user } = buildQuotePrompt(product);
    expect(user).toContain("달의 정원");
    expect(user).toContain("김서연");
    expect(system).toContain("한 글자도 바꾸지 않고");
    expect(system).toContain("2곳 이상");
  });
});
