import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { Draft } from "@contract/domain.js";
import { createMessenger } from "./telegram.js";

const OWNER = 111;

/** 실제 네트워크 없이 sendMessage 호출만 기록하는 가짜 API. */
const fakeApi = () => {
  const sendMessage = vi.fn(async () => ({}));
  const sendPhoto = vi.fn<(chatId: number, photo: unknown) => Promise<object>>(async () => ({}));
  return { sendMessage, sendPhoto, api: { sendMessage, sendPhoto } as unknown as Pick<Api, "sendMessage" | "sendPhoto"> };
};

const draft: Draft = {
  id: 5,
  category: "book",
  mode: "daily",
  status: "awaiting_approval",
  products: [
    { externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "책", url: "https://example.com/1", priceKrw: null, priceAsOf: null, specs: {} },
  ],
  body: { category: "book", title: "제목", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null },
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

  it("[REQ-035] 사진은 소유자 채팅으로 보낸다", async () => {
    const { api, sendPhoto } = fakeApi();
    await createMessenger(api, 111).sendPhoto("/m/a.jpg");
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto.mock.calls[0]![0]).toBe(111);
  });

  it("[REQ-012] 핸드오프용 sendChunk는 한도 분할 없이 소유자 채팅으로 한 통만 보낸다", async () => {
    const { sendMessage, api } = fakeApi();
    await createMessenger(api, OWNER).sendChunk("본문 한 통");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(OWNER, "본문 한 통");
  });

  it("[REQ-013] 발행 실패 알림은 `다시 시도 / 폐기` 버튼과 함께 간다(버튼은 같은 초안 번호를 가리킨다)", async () => {
    const { sendMessage, api } = fakeApi();
    await createMessenger(api, OWNER).notifyFailure(5, "발행 실패");
    const [chatId, text, options] = sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    expect(chatId).toBe(OWNER);
    expect(text).toBe("발행 실패");
    const buttons = options.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["다시 시도", "폐기"]);
    expect(buttons.map((b) => JSON.parse(b.callback_data))).toEqual([
      { action: "publish", draftId: 5 },
      { action: "discard", draftId: 5 },
    ]);
  });

  it("[REQ-007] 알림은 소유자 채팅으로 텍스트로 간다", async () => {
    const { sendMessage, api } = fakeApi();
    await createMessenger(api, OWNER).notify("안녕");
    expect(sendMessage).toHaveBeenCalledWith(OWNER, "안녕");
  });
});
