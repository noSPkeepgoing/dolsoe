import { describe, expect, it } from "vitest";

import type { Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

import { appendDisclosures, missingDisclosures, requiredDisclosures } from "./disclosure.js";

const product = (affiliate: Product["affiliate"], id: string): Product => ({
  externalId: id,
  source: affiliate === "coupang" ? "coupang_link" : "yes24",
  category: affiliate === "coupang" ? "appliance" : "book",
  affiliate,
  title: `상품 ${id}`,
  url: `https://example.com/${id}`,
  priceKrw: null,
  priceAsOf: null,
  specs: {},
});

describe("대가성 문구 게이트", () => {
  it("[REQ-010] 제휴 프로그램별로 필요한 문구를 중복 없이 구한다", () => {
    expect(requiredDisclosures([product("coupang", "1"), product("coupang", "2")])).toEqual([DISCLOSURE_TEXTS.coupang]);
    expect(requiredDisclosures([product("coupang", "1"), product("yes24", "2")])).toEqual([
      DISCLOSURE_TEXTS.coupang,
      DISCLOSURE_TEXTS.yes24,
    ]);
  });

  it("[REQ-010] 문구를 붙이면 빠진 문구가 없다", () => {
    const products = [product("coupang", "1")];
    const text = appendDisclosures("본문", products);
    expect(text).toContain("본문");
    expect(text).toContain(DISCLOSURE_TEXTS.coupang);
    expect(missingDisclosures(text, products)).toEqual([]);
  });

  it("[REQ-010] 문구를 제거한 본문은 빠진 문구를 알려준다(발행 차단 근거)", () => {
    const products = [product("coupang", "1"), product("yes24", "2")];
    const text = `본문\n\n${DISCLOSURE_TEXTS.coupang}`;
    expect(missingDisclosures(text, products)).toEqual([DISCLOSURE_TEXTS.yes24]);
    expect(missingDisclosures("본문", products)).toHaveLength(2);
  });
});
