import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";
import { LLM_MODEL_REVIEW, REVIEW_SEARCH_MAX_USES, REVIEW_SOURCES_MAX } from "@contract/domain.js";

import { LlmRefusalError } from "./body-generator.js";
import { buildReviewPrompt, createReviewCollector } from "./review-collector.js";

const product: Product = {
  externalId: "1",
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: "가호",
  url: "https://www.yes24.com/addon/1",
  priceKrw: 15000,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: { 저자: "무라카미 하루키 저" },
};

const searchResult = (url: string, title = "후기") => ({ type: "web_search_result", url, title, encrypted_content: "x", page_age: null });
const searchBlock = (content: unknown) => ({ type: "web_search_tool_result", tool_use_id: "srv_1", content });
const text = (value: string) => ({ type: "text", text: value });
const cite = (url: string, citedText: string) => ({ type: "web_search_result_location", url, title: "후기", cited_text: citedText, encrypted_index: "i" });
const cited = (value: string, ...citations: ReturnType<typeof cite>[]) => ({ type: "text", text: value, citations });
const usage = (extra: Record<string, unknown> = {}) => ({ input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, ...extra });

const fakeClient = (...responses: Record<string, unknown>[]) => {
  const create = vi.fn<(params: Record<string, unknown>) => Promise<Record<string, unknown>>>();
  for (const response of responses) create.mockResolvedValueOnce(response);
  return { client: { messages: { create } } as unknown as Pick<Anthropic, "messages">, create };
};

describe("createReviewCollector", () => {
  it("[REQ-016] 웹검색 도구(최대 REVIEW_SEARCH_MAX_USES회)를 붙여 후기 모델에 요청하고, 의역 노트와 출처 URL을 돌려준다", async () => {
    const { client, create } = fakeClient({
      content: [text("준비 중"), searchBlock([searchResult("https://blog.example.com/a"), searchResult("https://blog.example.com/b")]), text("- 분위기: 잔잔하다는 평이 많아요")],
      stop_reason: "end_turn",
      usage: usage({ server_tool_use: { web_search_requests: 2 } }),
    });
    const evidence = await createReviewCollector({ client, onUsage: () => {} }).collect(product);

    expect(evidence.sources).toEqual(["https://blog.example.com/a", "https://blog.example.com/b"]);
    expect(evidence.notes).toContain("잔잔하다는 평이 많아요");
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe(LLM_MODEL_REVIEW);
    expect(params.tools).toEqual([expect.objectContaining({ name: "web_search", max_uses: REVIEW_SEARCH_MAX_USES })]);
  });

  it("[REQ-016] YES24 도메인은 검색에서 뺀다(YES24 후기 페이지를 쓰지 않는 ADR-010)", async () => {
    const { client, create } = fakeClient({ content: [], stop_reason: "end_turn", usage: usage() });
    await createReviewCollector({ client, onUsage: () => {} }).collect(product);
    const [tool] = create.mock.calls[0]![0].tools as { blocked_domains?: string[] }[];
    expect(tool?.blocked_domains).toContain("yes24.com");
  });

  it("[REQ-016] 노트에 실제 인용된 URL만 출처로 센다(검색에 걸렸을 뿐인 페이지는 '참고'가 아니다)", async () => {
    const { client } = fakeClient({
      content: [
        searchBlock([searchResult("https://blog.example.com/a"), searchResult("https://blog.example.com/b"), searchResult("https://blog.example.com/unused")]),
        cited("잔잔하다는 평", cite("https://blog.example.com/a", "원문 일부 A")),
        cited("이 많다", cite("https://blog.example.com/a", "원문 일부 A2"), cite("https://blog.example.com/b", "원문 일부 B")),
      ],
      stop_reason: "end_turn",
      usage: usage(),
    });
    const evidence = await createReviewCollector({ client, onUsage: () => {} }).collect(product);
    expect(evidence.sources).toEqual(["https://blog.example.com/a", "https://blog.example.com/b"]);
  });

  it("[REQ-016] 인용 단위로 쪼개진 텍스트 블록은 이어 붙여 문장 중간 줄바꿈이 없게 하고, 인용 원문 조각은 대조용으로 돌려준다", async () => {
    const { client } = fakeClient({
      content: [
        searchBlock([searchResult("https://blog.example.com/a")]),
        text("- 분위기: "),
        cited("독자들은 맑고 투명하다고", cite("https://blog.example.com/a", "맑고 투명한 시간이었다")),
        cited(" 느꼈다고 해요.", cite("https://blog.example.com/a", "맑고 투명한 시간이었다"), cite("https://blog.example.com/a", "분량이 길지 않다")),
      ],
      stop_reason: "end_turn",
      usage: usage(),
    });
    const evidence = await createReviewCollector({ client, onUsage: () => {} }).collect(product);
    expect(evidence.notes).toBe("- 분위기: 독자들은 맑고 투명하다고 느꼈다고 해요.");
    expect(evidence.excerpts).toEqual(["맑고 투명한 시간이었다", "분량이 길지 않다"]);
  });

  it("[ADR-007] Sonnet 5.5가 400으로 거부하는 파라미터를 보내지 않는다", async () => {
    const { client, create } = fakeClient({ content: [], stop_reason: "end_turn", usage: usage() });
    await createReviewCollector({ client, onUsage: () => {} }).collect(product);
    const params = create.mock.calls[0]![0];
    for (const forbidden of ["temperature", "top_p", "top_k", "tool_choice"]) expect(params).not.toHaveProperty(forbidden);
    expect(params.thinking).not.toEqual({ type: "disabled" });
  });

  it("[REQ-016] 같은 URL은 한 번만, 출처는 REVIEW_SOURCES_MAX개까지만 남긴다", async () => {
    const many = Array.from({ length: REVIEW_SOURCES_MAX + 5 }, (_, i) => searchResult(`https://blog.example.com/${i}`));
    const { client } = fakeClient({
      content: [searchBlock([searchResult("https://blog.example.com/0"), ...many]), text("- 메모")],
      stop_reason: "end_turn",
      usage: usage(),
    });
    const evidence = await createReviewCollector({ client, onUsage: () => {} }).collect(product);
    expect(evidence.sources).toHaveLength(REVIEW_SOURCES_MAX);
    expect(new Set(evidence.sources).size).toBe(REVIEW_SOURCES_MAX);
  });

  it("[REQ-016] 검색 오류(content가 오류 객체)나 http가 아닌 URL은 출처로 치지 않고, 출처가 없으면 모델 글도 근거로 쓰지 않는다", async () => {
    const { client } = fakeClient({
      content: [searchBlock({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }), text("검증할 수 없는 그럴듯한 후기 요약")],
      stop_reason: "end_turn",
      usage: usage(),
    });
    expect(await createReviewCollector({ client, onUsage: () => {} }).collect(product)).toEqual({ notes: "", sources: [] });

    const bad = fakeClient({ content: [searchBlock([searchResult("javascript:alert(1)")]), text("메모")], stop_reason: "end_turn", usage: usage() });
    expect((await createReviewCollector({ client: bad.client, onUsage: () => {} }).collect(product)).sources).toEqual([]);
  });

  it("[NFR-001] 토큰과 웹검색 횟수를 보고하고, pause_turn이면 이어서 호출해 사용량을 합산한다", async () => {
    const paused = { content: [searchBlock([searchResult("https://blog.example.com/a")])], stop_reason: "pause_turn", usage: usage({ server_tool_use: { web_search_requests: 1 } }) };
    const done = { content: [text("- 메모")], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 100, server_tool_use: { web_search_requests: 1 } } };
    const { client, create } = fakeClient(paused, done);
    const onUsage = vi.fn();
    const evidence = await createReviewCollector({ client, onUsage }).collect(product);

    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1]![0] as { messages: { role: string }[] };
    expect(second.messages.at(-1)?.role).toBe("assistant"); // 서버가 이어서 하도록 "계속해줘" 메시지를 덧붙이지 않는다
    expect(evidence.sources).toEqual(["https://blog.example.com/a"]);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenNthCalledWith(1, { model: LLM_MODEL_REVIEW, inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, webSearchRequests: 1 });
    expect(onUsage).toHaveBeenNthCalledWith(2, { model: LLM_MODEL_REVIEW, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, webSearchRequests: 1 });
  });

  it("[REQ-016] 거절(refusal)은 LlmRefusalError — 사용량은 먼저 보고한다", async () => {
    const { client } = fakeClient({ content: [], stop_reason: "refusal", usage: usage() });
    const onUsage = vi.fn();
    await expect(createReviewCollector({ client, onUsage }).collect(product)).rejects.toBeInstanceOf(LlmRefusalError);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});

describe("buildReviewPrompt", () => {
  it("[REQ-016] 책 제목·저자를 검색 대상으로 주고, 의역만·인용 금지·1인칭 경험 금지·URL 금지 규칙을 담는다", () => {
    const { system, user } = buildReviewPrompt(product);
    expect(user).toContain("가호");
    expect(user).toContain("무라카미 하루키");
    for (const rule of ["의역", "따옴표", "1인칭", "URL"]) expect(system).toContain(rule);
  });
});
