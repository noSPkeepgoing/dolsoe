import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { Draft } from "@contract/domain.js";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { createMessenger } from "./telegram.js";

const OWNER = 111;

/** 실제 네트워크 없이 sendMessage 호출만 기록하는 가짜 API. */
const fakeApi = () => {
  const sendMessage = vi.fn(async () => ({}));
  return { sendMessage, api: { sendMessage } as unknown as Pick<Api, "sendMessage"> };
};

const draft: Draft = {
  id: 5,
  category: "book",
  mode: "daily",
  status: "awaiting_approval",
  products: [
    { externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "책", url: "https://example.com/1", priceKrw: null, priceAsOf: null, specs: {} },
  ],
  body: { category: "book", title: "제목", intro: "소개", items: [{ productExternalId: "1", oneLiner: "o", reason: "r" }], experienceLine: null },
  memo: null,
  quality: { bannedPhrasesFound: [], hasExperienceLine: false },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("createMessenger", () => {
  it("[REQ-007] 카드는 소유자 채팅으로 버튼 3개(인라인 키보드)와 함께 한 통으로 간다", async () => {
    const { sendMessage, api } = fakeApi();
    await createMessenger(api, OWNER).deliverCard(draft);
    const [chatId, text, options] = sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: { inline_keyboard: { text: string }[][] } }];
    expect(chatId).toBe(OWNER);
    expect(text).toContain("초안 #5");
    expect(options.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(["발행", "수정", "폐기"]);
  });

  it("[REQ-007] 완성 본문이 한도를 넘으면 여러 통으로 나눠 보낸다(유실 없이)", async () => {
    const { sendMessage, api } = fakeApi();
    const text = Array.from({ length: 400 }, (_, i) => `줄 ${i} ${"가".repeat(30)}`).join("\n");
    await createMessenger(api, OWNER).deliverPost(text);
    const sent = sendMessage.mock.calls.map((call) => (call as unknown as [number, string])[1]);
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(sent.join("\n")).toBe(text);
  });

  it("[REQ-007] 알림은 소유자 채팅으로 텍스트로 간다", async () => {
    const { sendMessage, api } = fakeApi();
    await createMessenger(api, OWNER).notify("안녕");
    expect(sendMessage).toHaveBeenCalledWith(OWNER, "안녕");
  });
});
