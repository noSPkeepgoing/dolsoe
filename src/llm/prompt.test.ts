import { describe, expect, it } from "vitest";

import type { Product } from "@contract/domain.js";
import { BANNED_PHRASES } from "@contract/domain.js";

import { buildPrompt } from "./prompt.js";

const product = (externalId: string, over: Partial<Product> = {}): Product => ({
  externalId,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 제목 ${externalId}`,
  url: "https://www.yes24.com/Product/Goods/" + externalId + "?addon=secret-tracking",
  priceKrw: 15120,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: { 저자: "김서연" },
  ...over,
});

const base = { category: "book" as const, products: [product("1"), product("2")], memo: null, avoidPhrases: [], problems: [] };

describe("buildPrompt", () => {
  it("[REQ-002] 모델에게 상품 ID·제목·가격·기준일·스펙을 데이터로 준다", () => {
    const { user } = buildPrompt(base);
    expect(user).toContain("책 제목 1");
    expect(user).toContain("15120");
    expect(user).toContain("2026-10-01");
    expect(user).toContain("김서연");
    expect(user).toContain('"externalId": "1"');
  });

  it("[REQ-010] 제휴 링크는 모델에게 보내지 않는다(링크·대가성 문구는 렌더러가 붙인다)", () => {
    const { system, user } = buildPrompt(base);
    expect(user).not.toContain("https://");
    expect(user).not.toContain("secret-tracking");
    expect(system).toMatch(/링크|대가성/);
  });

  it("[REQ-011][REQ-015] 시스템 지침에 후기 창작 금지·금지 표현 전체·경험 한 줄은 null 규칙이 들어간다", () => {
    const { system } = buildPrompt(base);
    for (const phrase of BANNED_PHRASES) expect(system).toContain(phrase);
    expect(system).toMatch(/지어내지/);
    expect(system).toMatch(/experienceLine/);
    expect(system).toMatch(/null/);
  });

  it("[REQ-002] 카테고리별 골격 지침: 가전=비교표(행 수=상품 수), 책=큐레이션(모든 책 한 번씩)", () => {
    const appliance = buildPrompt({ ...base, category: "appliance", products: [product("1", { category: "appliance" })] });
    expect(appliance.system).toMatch(/비교표/);
    expect(appliance.system).toMatch(/행 수/);
    expect(buildPrompt(base).system).toMatch(/한 번씩/);
  });

  it("[REQ-006] 메모가 있을 때만 사용자 메모 섹션이 생긴다", () => {
    expect(buildPrompt(base).user).not.toContain("사용자 메모");
    expect(buildPrompt({ ...base, memo: "6인용, 신혼 부부용" }).user).toContain("6인용, 신혼 부부용");
  });

  it("[REQ-015] 재생성 시 쓰지 말아야 할 표현과 고쳐야 할 문제를 알려준다", () => {
    const { user } = buildPrompt({ ...base, avoidPhrases: ["에 대해 알아보겠습니다"], problems: ["비교표 행 수가 다릅니다"] });
    expect(user).toContain("에 대해 알아보겠습니다");
    expect(user).toContain("비교표 행 수가 다릅니다");
  });
});
