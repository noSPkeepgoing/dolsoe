import { GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { Draft } from "@contract/domain.js";
import { DISCLOSURE_TEXTS, TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { createHandoffPublisher } from "./handoff.js";
import { renderPostText } from "./renderer.js";

const draft: Draft = {
  id: 3,
  category: "book",
  mode: "daily",
  status: "publishing",
  products: [
    { externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "책", url: "https://www.yes24.com/addon/1", priceKrw: null, priceAsOf: null, specs: {} },
  ],
  body: { category: "book", title: "제목", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null },
  memo: null,
  quality: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const post = (content: string) => ({ draftId: 3, title: "제목", content, mustContain: [] });

describe("createHandoffPublisher", () => {
  it("[REQ-012] 수동(③) 방식이고, 최종 산출물은 대가성 문구가 붙은 완성 본문이다", () => {
    const publisher = createHandoffPublisher({ sendChunk: vi.fn() });
    expect(publisher.mode).toBe("manual");
    expect(publisher.render(draft)).toBe(renderPostText(draft));
    expect(publisher.render(draft)).toContain(DISCLOSURE_TEXTS.yes24);
  });

  it("[REQ-012] 본문이 한도를 넘으면 여러 통으로 나눠 보내고 성공(manual)을 돌려준다", async () => {
    const sendChunk = vi.fn(async () => {});
    const content = Array.from({ length: 400 }, (_, i) => `줄 ${i} ${"가".repeat(30)}`).join("\n");
    const result = await createHandoffPublisher({ sendChunk }).publish(post(content));

    const sent = sendChunk.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(sent.join("\n")).toBe(content);
    expect(result).toEqual({ ok: true, mode: "manual", url: null, externalId: null });
  });

  const rejected = (code: number) =>
    new GrammyError(`rejected ${code}`, { ok: false, error_code: code, description: "rejected" }, "sendMessage", {});

  it("[REQ-013] 첫 통을 텔레그램이 명확히 거절(429 등 4xx)했다면 아무것도 안 나간 것이라 재시도 가능으로 알린다", async () => {
    const sendChunk = vi.fn(async () => { throw rejected(429); });
    const result = await createHandoffPublisher({ sendChunk }).publish(post("본문"));
    expect(result).toMatchObject({ ok: false, mode: "manual", retryable: true, authExpired: false });
    expect(result.ok === false && result.reason).toContain("429");
  });

  it("[REQ-013] 네트워크 오류·타임아웃·5xx는 텔레그램이 이미 받았을 수 있어 불확실 — 재시도 불가로 알린다(ADR-006)", async () => {
    const errors = [new HttpError("timeout", new Error("ETIMEDOUT")), rejected(500), new Error("socket hang up")];
    for (const error of errors) {
      const sendChunk = vi.fn(async () => { throw error; });
      const result = await createHandoffPublisher({ sendChunk }).publish(post("본문"));
      expect(result).toMatchObject({ ok: false, retryable: false });
    }
  });

  it("[REQ-013] 일부만 나간 뒤 실패하면 중복 전달을 막으려 재시도 불가로 알린다", async () => {
    const sendChunk = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rejected(429));
    const content = Array.from({ length: 400 }, (_, i) => `줄 ${i} ${"가".repeat(30)}`).join("\n");
    const result = await createHandoffPublisher({ sendChunk }).publish(post(content));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.reason).toContain("일부");
  });
});
