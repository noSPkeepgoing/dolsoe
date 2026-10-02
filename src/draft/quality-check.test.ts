import { describe, expect, it } from "vitest";

import type { ApplianceBody, BookBody, Product } from "@contract/domain.js";

import { checkQuality, validateAgainstProducts } from "./quality-check.js";

const product = (externalId: string): Product => ({
  externalId,
  source: "coupang_link",
  category: "appliance",
  affiliate: "coupang",
  title: `제품 ${externalId}`,
  url: "https://example.com/" + externalId,
  priceKrw: 100000,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: {},
});

const appliance = (over: Partial<ApplianceBody> = {}): ApplianceBody => ({
  category: "appliance",
  title: "20평대 공기청정기 3종 비교",
  verdict: "가성비는 A, 정숙성은 B",
  comparison: {
    headers: ["제품", "가격"],
    rows: [
      ["제품 1", "10만원"],
      ["제품 2", "20만원"],
    ],
  },
  recommendations: [{ forWhom: "원룸", productExternalId: "1", reason: "작고 저렴" }],
  experienceLine: null,
  ...over,
});

const book = (over: Partial<BookBody> = {}): BookBody => ({
  category: "book",
  title: "이번 주 베스트셀러 2권",
  intro: "이번 주 많이 읽힌 책입니다.",
  items: [
    { productExternalId: "1", oneLiner: "한 줄", reason: "이유" },
    { productExternalId: "2", oneLiner: "한 줄", reason: "이유" },
  ],
  experienceLine: null,
  ...over,
});

describe("checkQuality", () => {
  it("[REQ-015] 봇이 만든 문장에 금지 표현이 있으면 찾아서 중복 없이 알려준다", () => {
    const report = checkQuality(
      appliance({ verdict: "이 제품에 대해 알아보겠습니다", title: "에 대해 알아보겠습니다 비교" }),
    );
    expect(report.bannedPhrasesFound).toEqual(["에 대해 알아보겠습니다"]);
  });

  it("[REQ-015] 표 셀·추천 이유·책 한 줄 소개 같은 중첩 필드도 검사한다", () => {
    const a = checkQuality(appliance({ comparison: { headers: ["a", "b"], rows: [["써봤더니 좋음", "x"]] } }));
    expect(a.bannedPhrasesFound).toContain("써봤더니");
    const b = checkQuality(book({ items: [{ productExternalId: "1", oneLiner: "직접 써보니", reason: "r" }] }));
    expect(b.bannedPhrasesFound).toContain("직접 써보니");
  });

  it("[REQ-015][REQ-011] 사용자가 준 경험 문장은 금지 표현 검사에서 제외한다", () => {
    const report = checkQuality(appliance({ experienceLine: "써봤더니 소음이 컸어요" }));
    expect(report.bannedPhrasesFound).toEqual([]);
    expect(report.hasExperienceLine).toBe(true);
  });

  it("[REQ-015] 경험 한 줄 유무: 문장이 있으면 true, null이나 공백뿐이면 false", () => {
    expect(checkQuality(appliance({ experienceLine: "소음이 컸어요" })).hasExperienceLine).toBe(true);
    expect(checkQuality(appliance({ experienceLine: null })).hasExperienceLine).toBe(false);
    expect(checkQuality(appliance({ experienceLine: "   " })).hasExperienceLine).toBe(false);
  });

  it("[REQ-015] 깨끗한 초안은 금지 표현 0개", () => {
    expect(checkQuality(book()).bannedPhrasesFound).toEqual([]);
  });
});

describe("validateAgainstProducts", () => {
  it("[REQ-002] 골격이 맞으면(표 행 수=상품 수, 추천이 실제 상품을 가리킴) 문제가 없다", () => {
    expect(validateAgainstProducts(appliance(), [product("1"), product("2")])).toEqual([]);
    expect(validateAgainstProducts(book(), [product("1"), product("2")])).toEqual([]);
  });

  it("[REQ-002] 모델이 만든 상품 ID(없는 상품)를 참조하면 문제로 잡는다", () => {
    const problems = validateAgainstProducts(
      appliance({ recommendations: [{ forWhom: "x", productExternalId: "999", reason: "r" }] }),
      [product("1"), product("2")],
    );
    expect(problems.join(" ")).toMatch(/999/);
  });

  it("[REQ-002] 비교표 행 수가 상품 수와 다르거나 열 수가 머리글과 다르면 문제로 잡는다", () => {
    const wrongRows = validateAgainstProducts(
      appliance({ comparison: { headers: ["a", "b"], rows: [["1", "2"]] } }),
      [product("1"), product("2")],
    );
    expect(wrongRows.length).toBeGreaterThan(0);
    const wrongCols = validateAgainstProducts(
      appliance({ comparison: { headers: ["a", "b"], rows: [["1"], ["2", "3"]] } }),
      [product("1"), product("2")],
    );
    expect(wrongCols.length).toBeGreaterThan(0);
  });

  it("[REQ-002] 책 소개가 같은 책을 두 번 쓰거나, 소개되지 않은 책이 있으면 문제로 잡는다", () => {
    const dup = validateAgainstProducts(
      book({ items: [
        { productExternalId: "1", oneLiner: "a", reason: "b" },
        { productExternalId: "1", oneLiner: "a", reason: "b" },
      ] }),
      [product("1"), product("2")],
    );
    expect(dup.length).toBeGreaterThan(0);
  });
});
