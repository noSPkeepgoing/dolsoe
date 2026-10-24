import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";

import { buildSpecPrompt, createSpecCollector, parseSpecLines } from "./spec-collector.js";

const product: Product = {
  externalId: "A", source: "coupang_link", category: "appliance", affiliate: "coupang", title: "A 에어프라이어",
  url: "https://link.coupang.com/a/A", priceKrw: null, priceAsOf: null, specs: {},
};

describe("parseSpecLines", () => {
  it("[REQ-028] '항목: 값' 줄만 읽고 요청하지 않은 항목은 버린다", () => {
    expect(parseSpecLines("용량: 3.5L\n- 용량：5L\n색상: 검정\n설명하면 이렇습니다", ["용량"])).toEqual([
      { key: "용량", value: "3.5L" },
      { key: "용량", value: "5L" },
    ]);
  });
});

describe("createSpecCollector", () => {
  it("[REQ-028] 인용된 원문 조각+URL을 근거로, 줄을 후보로 돌려주고 쿠팡 도메인은 검색에서 뺀다", async () => {
    const create = vi.fn(async () => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } },
      content: [
        { type: "web_search_tool_result", content: [{ url: "https://a.example/1" }, { url: "https://b.example/1" }] },
        { type: "text", text: "용량: 3.5L", citations: [
          { type: "web_search_result_location", url: "https://a.example/1", cited_text: "용량 3.5L" },
          { type: "web_search_result_location", url: "https://b.example/1", cited_text: "3.5L 대용량" },
          { type: "web_search_result_location", url: "https://made-up.example/", cited_text: "3.5L" },
        ] },
      ],
    }));
    const onUsage = vi.fn();
    const result = await createSpecCollector({ client: { messages: { create } } as never, onUsage }).collect(product, ["용량"]);

    expect(result.candidates).toEqual([{ key: "용량", value: "3.5L" }]);
    expect(result.evidence.map((e) => e.url)).toEqual(["https://a.example/1", "https://b.example/1"]); // 검색 결과에 없던 URL은 버림
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ webSearchRequests: 2 }));
    const request = (create.mock.calls[0] as unknown as [{ tools: { blocked_domains: string[] }[] }])[0];
    expect(request.tools[0]!.blocked_domains).toContain("coupang.com");
  });

  it("[REQ-028] 프롬프트에 상품명과 찾을 항목이 들어간다", () => {
    expect(buildSpecPrompt(product, ["용량"]).user).toContain("A 에어프라이어");
  });
});
