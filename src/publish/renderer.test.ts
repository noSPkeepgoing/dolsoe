import { describe, expect, it } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

import { renderPostText, renderPreview } from "./renderer.js";

const product = (id: string, over: Partial<Product> = {}): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}`,
  priceKrw: 15120,
  priceAsOf: "2026-10-01T15:00:00.000Z", // KST 10/02 00:00
  specs: {},
  ...over,
});

const bookBody = (experienceLine: string | null = null): DraftBody => ({
  category: "book",
  title: "퇴근 후 에세이 2권",
  intro: "가볍게 읽히는 책을 골랐어요",
  items: [
    { productExternalId: "1", oneLiner: "첫 책 한 줄", reason: "첫 책 이유" },
    { productExternalId: "2", oneLiner: "둘째 책 한 줄", reason: "둘째 책 이유" },
  ],
  experienceLine,
});

const applianceBody = (): DraftBody => ({
  category: "appliance",
  title: "청소기 2종 비교",
  verdict: "가성비는 A",
  comparison: { headers: ["제품", "가격"], rows: [["청소기 A", "30만원"], ["청소기 B", "50만원"]] },
  recommendations: [{ forWhom: "원룸", productExternalId: "a", reason: "작고 가벼움" }],
  experienceLine: null,
});

const draft = (body: DraftBody, products: Product[]): Draft => ({
  id: 1,
  category: body.category,
  mode: "daily",
  status: "awaiting_approval",
  products,
  body,
  memo: null,
  quality: { bannedPhrasesFound: [], hasExperienceLine: false },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("renderPostText", () => {
  const books = draft(bookBody(), [product("1"), product("2")]);

  it("[REQ-002] 책 본문은 제목→책마다 한 줄 소개와 이유→구매 링크 순서다", () => {
    const text = renderPostText(books);
    const order = ["퇴근 후 에세이 2권", "첫 책 한 줄", "둘째 책 이유", "https://www.yes24.com/addon/1"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("[REQ-002] 가전 본문은 한 줄 결론과 비교표·추천이 들어간다", () => {
    const text = renderPostText(draft(applianceBody(), [product("a", { category: "appliance", affiliate: "coupang", source: "coupang_link" }), product("b", { category: "appliance", affiliate: "coupang", source: "coupang_link" })]));
    expect(text).toContain("가성비는 A");
    expect(text).toContain("청소기 A | 30만원");
    expect(text).toContain("원룸");
  });

  it("[REQ-010] 제휴 링크가 있는 글에는 대가성 문구가 마지막에 자동으로 붙는다", () => {
    const text = renderPostText(books);
    expect(text).toContain(DISCLOSURE_TEXTS.yes24);
    expect(text.trimEnd().endsWith(DISCLOSURE_TEXTS.yes24)).toBe(true);
  });

  it("[REQ-011] 가격은 단정하지 않고 KST 기준일을 함께 적는다", () => {
    const text = renderPostText(books);
    expect(text).toContain("15,120원");
    expect(text).toContain("10/02 기준");
  });

  it("[REQ-011] 가격 정보가 없으면 가격 줄 없이 링크만 적는다", () => {
    const text = renderPostText(draft(bookBody(), [product("1", { priceKrw: null, priceAsOf: null }), product("2")]));
    expect(text).toContain("https://www.yes24.com/addon/1");
    expect(text).not.toContain("null");
  });

  it("[REQ-011] 경험 한 줄이 비어 있으면 경험 문단이 빠지고, 있으면 원문 그대로 들어간다", () => {
    expect(renderPostText(books)).not.toContain("내 경험");
    const text = renderPostText(draft(bookBody("소음이 생각보다 컸어요"), [product("1"), product("2")]));
    expect(text).toContain("내 경험");
    expect(text).toContain("소음이 생각보다 컸어요");
  });
});

describe("renderPreview", () => {
  it("[REQ-007] 미리보기는 한도를 넘으면 잘리고 잘렸음을 표시한다", () => {
    const long = draft({ ...bookBody(), intro: "가".repeat(5000) } as DraftBody, [product("1"), product("2")]);
    const preview = renderPreview(long, 300);
    expect(preview.length).toBeLessThanOrEqual(300);
    expect(preview).toContain("…");
  });

  it("[REQ-007] 한도 안이면 그대로 보여준다(링크·대가성 문구는 미리보기에 넣지 않는다)", () => {
    const preview = renderPreview(draft(bookBody(), [product("1"), product("2")]), 2500);
    expect(preview).toContain("퇴근 후 에세이 2권");
    expect(preview).not.toContain("https://");
  });
});
