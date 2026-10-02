import { describe, expect, it } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { BotCallbackSchema, TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { formatCard, parseCallbackData, splitMessage } from "./card.js";

const product = (id: string): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}`,
  priceKrw: 10000,
  priceAsOf: "2026-10-01T15:00:00.000Z", // KST 10/02
  specs: {},
});

const body = (intro = "소개"): DraftBody => ({
  category: "book",
  title: "퇴근 후 에세이 2권",
  intro,
  items: [
    { productExternalId: "1", oneLiner: "한 줄", reason: "이유" },
    { productExternalId: "2", oneLiner: "한 줄", reason: "이유" },
  ],
  experienceLine: null,
});

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 12,
  category: "book",
  mode: "daily",
  status: "awaiting_approval",
  products: [product("1"), product("2")],
  body: body(),
  memo: null,
  quality: { bannedPhrasesFound: [], hasExperienceLine: false },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("formatCard", () => {
  it("[REQ-007] 본문 미리보기와 `발행 / 수정 / 폐기` 버튼 3개가 함께 보인다", () => {
    const { text, buttons } = formatCard(draft());
    expect(text).toContain("초안 #12");
    expect(text).toContain("퇴근 후 에세이 2권");
    expect(buttons.map((b) => b.label)).toEqual(["발행", "수정", "폐기"]);
  });

  it("[REQ-007] 버튼 콜백은 계약(BotCallbackSchema)대로 초안 ID를 담는다", () => {
    const { buttons } = formatCard(draft({ id: 12 }));
    const parsed = buttons.map((b) => BotCallbackSchema.parse(JSON.parse(b.data)));
    expect(parsed).toEqual([
      { action: "publish", draftId: 12 },
      { action: "revise", draftId: 12 },
      { action: "discard", draftId: 12 },
    ]);
    for (const b of buttons) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64); // 텔레그램 callback_data 한도
  });

  it("[REQ-015] 품질 한 줄: 금지 표현 개수와 경험 한 줄 있음/없음", () => {
    expect(formatCard(draft()).text).toContain("품질: 금지 표현 0개 · 경험 한 줄 없음");
    const dirty = draft({ quality: { bannedPhrasesFound: ["a", "b"], hasExperienceLine: true } });
    expect(formatCard(dirty).text).toContain("품질: 금지 표현 2개 · 경험 한 줄 있음");
  });

  it("[REQ-007] 모드·카테고리·상품 수·가격 기준일(KST)을 보여준다", () => {
    const text = formatCard(draft()).text;
    expect(text).toContain("책 추천");
    expect(text).toContain("기본 모드");
    expect(text).toContain("YES24 2권");
    expect(text).toContain("가격 기준 10/02");
    expect(formatCard(draft({ mode: "link" })).text).toContain("링크 모드");
  });

  it("[REQ-007] 본문이 아주 길어도 카드는 텔레그램 메시지 한도를 넘지 않는다", () => {
    const { text } = formatCard(draft({ body: body("가".repeat(10_000)) }));
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(text).toContain("품질:"); // 잘려도 품질 줄은 남는다
  });
});

describe("parseCallbackData", () => {
  it("[REQ-007] 올바른 콜백만 BotCallback으로, 나머지는 null", () => {
    expect(parseCallbackData('{"action":"publish","draftId":3}')).toEqual({ action: "publish", draftId: 3 });
    for (const bad of ["not json", '{"action":"delete","draftId":3}', '{"action":"publish"}', '{"action":"publish","draftId":-1}']) {
      expect(parseCallbackData(bad)).toBeNull();
    }
  });
});

describe("splitMessage", () => {
  it("[REQ-007] 한도 안이면 그대로 한 통", () => {
    expect(splitMessage("짧은 글", 100)).toEqual(["짧은 글"]);
  });

  it("[REQ-007] 한도를 넘으면 줄 경계에서 나눠 모든 조각이 한도 이하고, 이어붙이면 원문이 유지된다", () => {
    const text = Array.from({ length: 50 }, (_, i) => `줄 ${i} ${"가".repeat(20)}`).join("\n");
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join("\n")).toBe(text);
  });

  it("[REQ-007] 한 줄 자체가 한도보다 길어도 강제로 잘라 유실 없이 보낸다", () => {
    const chunks = splitMessage("가".repeat(450), 200);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.join("")).toBe("가".repeat(450));
  });
});
