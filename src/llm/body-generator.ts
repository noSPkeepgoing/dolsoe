import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { DraftBody } from "@contract/domain.js";
import { ApplianceBodySchema, BookBodySchema, LLM_MODEL_BODY } from "@contract/domain.js";

import type { BodyGenerator, GenerateBodyInput } from "../draft/generate.js";

import { buildPrompt } from "./prompt.js";

/** 적응형 사고 토큰도 이 한도에 포함되므로 넉넉히 둔다(비스트리밍 권장 기본값). */
const BODY_MAX_TOKENS = 16_000;

export class LlmRefusalError extends Error {}
export class LlmOutputError extends Error {}

export interface LlmUsageReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 웹검색 서버 도구 호출 횟수(REQ-016). 토큰과 별도 단가로 청구된다. 본문 생성에는 없다. */
  webSearchRequests?: number;
}

/**
 * ADR-007: 본문 생성. 카테고리별 zod 스키마로 구조화 출력을 받는다(경계 검증).
 * Sonnet 5.5는 temperature 등 샘플링 값·thinking 끄기·강제 tool_choice·prefill을 400으로 거부하므로 보내지 않는다.
 * 거절·빈 결과도 과금되므로 사용량은 결과 판정 전에 먼저 보고한다.
 */
export function createBodyGenerator(options: {
  client: Pick<Anthropic, "messages">;
  onUsage: (usage: LlmUsageReport) => void;
}): BodyGenerator {
  return {
    async generateBody(input: GenerateBodyInput): Promise<DraftBody> {
      const { system, user } = buildPrompt(input);
      const request = {
        model: LLM_MODEL_BODY,
        max_tokens: BODY_MAX_TOKENS,
        system,
        messages: [{ role: "user" as const, content: user }],
      };

      const response =
        input.category === "appliance"
          ? await options.client.messages.parse({ ...request, output_config: { format: zodOutputFormat(ApplianceBodySchema) } })
          : await options.client.messages.parse({ ...request, output_config: { format: zodOutputFormat(BookBodySchema) } });

      options.onUsage({
        model: LLM_MODEL_BODY,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      });

      if (response.stop_reason === "refusal") throw new LlmRefusalError("모델이 요청을 거절했습니다");
      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new LlmOutputError(`모델 출력을 파싱하지 못했습니다(stop_reason: ${String(response.stop_reason)})`);
      }
      return response.parsed_output;
    },
  };
}
