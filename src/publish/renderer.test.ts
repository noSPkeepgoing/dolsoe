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
  title: "퇴근 후 읽기 좋은 에세이 한 권",
  synopsis: "줄거리 문단이에요",
  mood: "분위기 문단이에요",
  recommendedFor: "이런 사람 문단이에요",
  highlights: "인상 깊은 대목 문단이에요",
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
  const books = draft(bookBody(), [product("1")]);

  it("[REQ-002] 책 본문은 제목→줄거리→분위기→이런 사람에게→인상 깊은 대목→구매 링크 순서다(B3 한 권 리뷰)", () => {
    const text = renderPostText(books);
    const order = [
      "퇴근 후 읽기 좋은 에세이 한 권",
      "줄거리 문단이에요",
      "분위기 문단이에요",
      "이런 사람 문단이에요",
      "인상 깊은 대목 문단이에요",
      "https://www.yes24.com/addon/1",
    ].map((s) => text.indexOf(s));
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
    const text = renderPostText(draft(bookBody(), [product("1", { priceKrw: null, priceAsOf: null })]));
    expect(text).toContain("https://www.yes24.com/addon/1");
    expect(text).not.toContain("null");
  });

  it("[REQ-011] 경험 한 줄이 비어 있으면 경험 문단이 빠지고, 있으면 원문 그대로 들어간다", () => {
    expect(renderPostText(books)).not.toContain("내 경험");
    const text = renderPostText(draft(bookBody("소음이 생각보다 컸어요"), [product("1")]));
    expect(text).toContain("내 경험");
    expect(text).toContain("소음이 생각보다 컸어요");
  });
});

describe("renderPreview", () => {
  it("[REQ-007] 미리보기는 한도를 넘으면 잘리고 잘렸음을 표시한다", () => {
    const long = draft({ ...bookBody(), synopsis: "가".repeat(5000) } as DraftBody, [product("1")]);
    const preview = renderPreview(long, 300);
    expect(preview.length).toBeLessThanOrEqual(300);
    expect(preview).toContain("…");
  });

  it("[REQ-007] 한도 안이면 그대로 보여준다(링크·대가성 문구는 미리보기에 넣지 않는다)", () => {
    const preview = renderPreview(draft(bookBody(), [product("1")]), 2500);
    expect(preview).toContain("퇴근 후 읽기 좋은 에세이 한 권");
    expect(preview).not.toContain("https://");
  });
});

describe("새 코너(REQ-027·032) — 도입·마무리·태그", () => {
  const styled = (): DraftBody => ({ ...(bookBody() as Extract<DraftBody, { category: "book" }>), intro: "도입이에요", closing: "마무리예요", tags: ["하루키", "소설추천"] });

  it("[REQ-027] 도입은 제목 다음, 마무리는 본문 끝(구매 링크 앞)에 들어간다", () => {
    const text = renderPostText(draft(styled(), [product("1")]));
    const at = ["퇴근 후 읽기 좋은 에세이 한 권", "도입이에요", "줄거리 문단이에요", "마무리예요", "https://www.yes24.com/addon/1"].map((part) => text.indexOf(part));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((i) => i >= 0)).toBe(true);
  });

  it("[REQ-032] 태그는 #을 붙여 한 줄로, 대가성 문구 앞에 들어간다(④ 전달본에서 복사해 쓴다)", () => {
    const text = renderPostText(draft(styled(), [product("1")]));
    expect(text).toContain("#하루키 #소설추천");
    expect(text.indexOf("#하루키")).toBeLessThan(text.indexOf(DISCLOSURE_TEXTS.yes24));
  });

  it("[REQ-027] 새 필드가 없으면 코너가 빠지고 미리보기에도 도입이 들어간다", () => {
    expect(renderPostText(draft(bookBody(), [product("1")]))).not.toContain("#");
    expect(renderPreview(draft(styled(), [product("1")]), 1000)).toContain("도입이에요");
  });
});

describe("근거 팩트 한 줄 (REQ-028)", () => {
  const appliance = (id: string, price: number, capacity: string): Product => ({
    ...product(id), source: "coupang_link", category: "appliance", affiliate: "coupang", url: `https://link.coupang.com/a/${id}`, priceKrw: price, specs: { 용량: capacity },
  });
  const products = [appliance("a", 59000, "3.5L"), appliance("c", 129000, "12L")];
  const body: DraftBody = {
    category: "appliance",
    title: "에어프라이어 2종 비교",
    verdict: "결론",
    comparison: { headers: ["제품", "가격"], rows: [["책 a", "5만9천원"], ["책 c", "12만9천원"]] },
    recommendations: [{ forWhom: "식구 많은 집", productExternalId: "c", reason: "4인 이상이라면 넉넉할 것 같아요", factIds: ["capacity_max"] }, { forWhom: "그냥", productExternalId: "a", reason: "가벼워요" }],
    experienceLine: null,
  };
  const draft: Draft = { id: 1, category: "appliance", mode: "link", status: "awaiting_approval", products, body, memo: null, quality: null, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };

  it("[REQ-028] 팩트를 가리키는 판단 문장 아래에 코드가 계산한 수치 한 줄이 붙고, 가리키지 않으면 붙지 않는다", () => {
    const text = renderPostText(draft);
    expect(text).toContain("(근거: 용량이 가장 큰 제품은 책 c(12L))");
    expect(text.match(/\(근거:/g)).toHaveLength(1);
  });
});
