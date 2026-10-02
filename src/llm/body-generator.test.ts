import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";
import { LLM_MODEL_BODY } from "@contract/domain.js";

import { LlmOutputError, LlmRefusalError, createBodyGenerator } from "./body-generator.js";

const product: Product = {
  externalId: "1",
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: "책",
  url: "https://example.com/1",
  priceKrw: 1000,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: {},
};
const body: DraftBody = {
  category: "book",
  title: "t",
  intro: "i",
  items: [{ productExternalId: "1", oneLiner: "o", reason: "r" }],
  experienceLine: null,
};

const fakeClient = (response: Record<string, unknown>) => {
  const parse = vi.fn<(params: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => response);
  return { client: { messages: { parse } } as unknown as Pick<Anthropic, "messages">, parse };
};
const input = { category: "book" as const, products: [product], memo: null, avoidPhrases: [], problems: [] };

describe("createBodyGenerator", () => {
  it("[ADR-007] 본문 모델로 구조화 출력을 요청하고 파싱된 본문을 돌려준다", async () => {
    const { client, parse } = fakeClient({ parsed_output: body, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500 } });
    const generator = createBodyGenerator({ client, onUsage: () => {} });
    expect(await generator.generateBody(input)).toEqual(body);
    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe(LLM_MODEL_BODY);
    expect(params.output_config).toBeDefined();
  });

  it("[ADR-007] Sonnet 5.5가 400으로 거부하는 파라미터(temperature·thinking 끄기·강제 tool_choice·prefill)를 보내지 않는다", async () => {
    const { client, parse } = fakeClient({ parsed_output: body, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    await createBodyGenerator({ client, onUsage: () => {} }).generateBody(input);
    const params = parse.mock.calls[0]![0];
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) expect(params).not.toHaveProperty(forbidden);
    const messages = params.messages as { role: string }[];
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  it("[NFR-001] 사용량(입력·출력·캐시 읽기 토큰)을 모델과 함께 보고한다", async () => {
    const { client } = fakeClient({
      parsed_output: body,
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
    });
    const onUsage = vi.fn();
    await createBodyGenerator({ client, onUsage }).generateBody(input);
    expect(onUsage).toHaveBeenCalledWith({ model: LLM_MODEL_BODY, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
  });

  it("[ADR-007] 거절(refusal)은 LlmRefusalError, 파싱 결과가 없으면 LlmOutputError — 단 사용량은 둘 다 보고한다(과금되므로)", async () => {
    const refusal = fakeClient({ parsed_output: null, stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 } });
    const onUsage = vi.fn();
    await expect(createBodyGenerator({ client: refusal.client, onUsage }).generateBody(input)).rejects.toBeInstanceOf(LlmRefusalError);
    const empty = fakeClient({ parsed_output: null, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(createBodyGenerator({ client: empty.client, onUsage }).generateBody(input)).rejects.toBeInstanceOf(LlmOutputError);
    expect(onUsage).toHaveBeenCalledTimes(2);
  });
});
