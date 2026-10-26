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

const body = (synopsis = "줄거리"): DraftBody => ({
  category: "book",
  title: "퇴근 후 읽기 좋은 에세이",
  synopsis,
  mood: "분위기",
  recommendedFor: "이런 사람에게",
  highlights: "인상 깊은 대목",
  experienceLine: null,
});

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 12,
  category: "book",
  mode: "daily",
  status: "awaiting_approval",
  products: [product("1")],
  body: body(),
  memo: null,
  quality: { bannedPhrasesFound: [], hasExperienceLine: false },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("formatCard — 스펙 출처 (REQ-028)", () => {
  const appliance = (specOrigin?: Draft["specOrigin"]): Draft =>
    draft({
      category: "appliance",
      products: [{ ...product("1"), category: "appliance", affiliate: "coupang", source: "coupang_link" }],
      body: { category: "appliance", title: "t", verdict: "v", comparison: { headers: ["a", "b"], rows: [["1", "2"]] }, recommendations: [{ forWhom: "w", productExternalId: "1", reason: "r" }], experienceLine: null },
      ...(specOrigin === undefined ? {} : { specOrigin }),
    });

  it("[REQ-028] 가전 카드에 스펙 출처 구분이 보인다(직접 입력 / 웹 확인 N건 / 확인 못 함)", () => {
    expect(formatCard(appliance({ user: 2, web: 0 })).text).toContain("스펙 출처: 직접 입력");
    expect(formatCard(appliance({ user: 1, web: 2 })).text).toContain("스펙 출처: 직접 입력 · 웹 확인 2건");
    expect(formatCard(appliance({ user: 0, web: 3 })).text).toContain("스펙 출처: 웹 확인 3건");
    expect(formatCard(appliance({ user: 0, web: 0 })).text).toContain("스펙 출처: 확인 못 함");
    expect(formatCard(appliance()).text).toContain("스펙 출처: 확인 못 함"); // 옛 초안
  });

  it("[REQ-028] 책 카드에는 스펙 출처 줄이 없다", () => {
    expect(formatCard(draft()).text).not.toContain("스펙 출처");
  });
});

describe("formatCard — 필사 문구 (REQ-029)", () => {
  const withQuote = (origin: "user" | "web" | "intro" | null) =>
    draft({ body: { ...(body() as Extract<DraftBody, { category: "book" }>), ...(origin === null ? {} : { quote: { text: "문장", attribution: "— 출처", origin } }) } });

  it("[REQ-029] 책 카드에 필사 문구 출처가 보이고, 없으면 문구를 보내달라고 요청한다 (EDGE-020)", () => {
    expect(formatCard(withQuote("user")).text).toContain("필사 문구: 직접 입력");
    expect(formatCard(withQuote("web")).text).toContain("필사 문구: 웹 2곳 확인");
    expect(formatCard(withQuote("intro")).text).toContain("필사 문구: 소개글");
    expect(formatCard(withQuote(null)).text).toContain("문구를 보내주시면 넣을게요");
  });
});

describe("formatCard", () => {
  it("[REQ-007] 본문 미리보기와 `발행 / 수정 / 폐기` 버튼 3개가 함께 보인다", () => {
    const { text, buttons } = formatCard(draft());
    expect(text).toContain("초안 #12");
    expect(text).toContain("퇴근 후 읽기 좋은 에세이");
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

  it("[REQ-015][REQ-030] 문체 점검 한 줄: 금지 표현(+문체 위반) 개수와 경험 있음/없음", () => {
    expect(formatCard(draft()).text).toContain("문체 점검 · 금지 표현 0개 · 경험 없음");
    const dirty = draft({ quality: { bannedPhrasesFound: ["a", "b"], hasExperienceLine: true } });
    expect(formatCard(dirty).text).toContain("문체 점검 · 금지 표현 2개 · 경험 있음");
    const styled = draft({ quality: { bannedPhrasesFound: ["a"], hasExperienceLine: false, styleIssues: ["눈물이 났", "느낌표 4개(최대 3)"] } });
    expect(formatCard(styled).text).toContain("문체 점검 · 금지 표현 3개 · 경험 없음");
  });

  it("[REQ-033] 태그가 있으면 카드에 복사하기 좋은 한 줄로 보인다(임시저장 후 발행 때 사람이 붙인다)", () => {
    const withTags = formatCard(draft({ body: { ...body(), tags: ["하루키", "소설추천", "책추천"] } })).text;
    expect(withTags).toContain("태그: #하루키 #소설추천 #책추천");
    expect(formatCard(draft()).text).not.toContain("태그:");
  });

  it("[REQ-016] 책 카드에 후기 근거 건수를 보여주고, 없으면 근거 없음을 표시한다(URL은 카드에 넣지 않는다)", () => {
    const withSources = formatCard(draft({ reviewSources: ["https://blog.example.com/a", "https://blog.example.com/b"] })).text;
    expect(withSources).toContain("후기 2건 참고");
    expect(withSources).not.toContain("https://");
    expect(formatCard(draft()).text).toContain("후기 근거 없음");
    expect(formatCard(draft({ reviewSources: [] })).text).toContain("후기 근거 없음");
  });

  it("[REQ-016] 가전 카드에는 후기 줄이 없다", () => {
    const appliance = draft({
      category: "appliance",
      body: { category: "appliance", title: "t", verdict: "v", comparison: { headers: ["a", "b"], rows: [["1", "2"]] }, recommendations: [{ forWhom: "x", productExternalId: "1", reason: "r" }], experienceLine: null },
    });
    expect(formatCard(appliance).text).not.toContain("후기");
  });

  it("[REQ-007] 모드·카테고리·상품 수·가격 기준일(KST)을 보여준다", () => {
    const text = formatCard(draft()).text;
    expect(text).toContain("책 추천");
    expect(text).toContain("기본 모드");
    expect(text).toContain("YES24 1권");
    expect(text).toContain("가격 기준 10/02");
    expect(formatCard(draft({ mode: "link" })).text).toContain("링크 모드");
  });

  it("[REQ-007] 본문이 아주 길어도 카드는 텔레그램 메시지 한도를 넘지 않는다", () => {
    const { text } = formatCard(draft({ body: body("가".repeat(10_000)) }));
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(text).toContain("문체 점검"); // 잘려도 점검 줄은 남는다
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
