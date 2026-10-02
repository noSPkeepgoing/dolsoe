import { describe, expect, it } from "vitest";

import type { CoveredProduct, Product } from "@contract/domain.js";
import { DEDUP_DAYS, MAX_PENDING_DRAFTS } from "@contract/domain.js";

import { filterRecentlyCovered, isPendingCapReached, nextCategory } from "./rules.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const product = (externalId: string): Product => ({
  externalId,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${externalId}`,
  url: "https://example.com/" + externalId,
  priceKrw: 10000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});

describe("nextCategory", () => {
  it("[REQ-001] 가전·책 둘 다 가능하면 마지막 생성 카테고리의 반대로 번갈아 간다", () => {
    expect(nextCategory("appliance", ["appliance", "book"])).toBe("book");
    expect(nextCategory("book", ["appliance", "book"])).toBe("appliance");
  });

  it("[REQ-001] 첫 실행(마지막 생성 없음)은 순서상 첫 카테고리(가전)부터 시작한다", () => {
    expect(nextCategory(null, ["appliance", "book"])).toBe("appliance");
  });

  it("[REQ-001][REQ-005] 자동 소스가 있는 카테고리가 하나뿐이면 항상 그 카테고리다(소스 없는 카테고리 차례에 갇히지 않음)", () => {
    expect(nextCategory("book", ["book"])).toBe("book");
    expect(nextCategory("appliance", ["book"])).toBe("book");
    expect(nextCategory(null, ["book"])).toBe("book");
  });

  it("[REQ-005] 자동 소스가 하나도 없으면 null", () => {
    expect(nextCategory(null, [])).toBeNull();
  });
});

describe("filterRecentlyCovered", () => {
  it("[REQ-003] 최근 DEDUP_DAYS일 안에 다룬 상품은 후보에서 제외한다", () => {
    const covered: CoveredProduct[] = [{ source: "yes24", externalId: "1", coveredAt: daysAgo(DEDUP_DAYS - 1) }];
    const result = filterRecentlyCovered([product("1"), product("2")], covered, NOW, DEDUP_DAYS);
    expect(result.map((p) => p.externalId)).toEqual(["2"]);
  });

  it("[REQ-003] 기간이 지난 상품은 다시 후보가 된다(경계: 정확히 N일 전은 포함)", () => {
    const covered: CoveredProduct[] = [
      { source: "yes24", externalId: "1", coveredAt: daysAgo(DEDUP_DAYS) },
      { source: "yes24", externalId: "2", coveredAt: daysAgo(DEDUP_DAYS + 1) },
    ];
    const result = filterRecentlyCovered([product("1"), product("2")], covered, NOW, DEDUP_DAYS);
    expect(result.map((p) => p.externalId)).toEqual(["1", "2"]);
  });

  it("[REQ-003] 같은 externalId라도 소스가 다르면 다른 상품이다", () => {
    const covered: CoveredProduct[] = [{ source: "coupang_link", externalId: "1", coveredAt: daysAgo(1) }];
    expect(filterRecentlyCovered([product("1")], covered, NOW, DEDUP_DAYS)).toHaveLength(1);
  });
});

describe("isPendingCapReached", () => {
  it("[REQ-004] 대기 초안이 상한 미만이면 false, 이상이면 true", () => {
    expect(isPendingCapReached(MAX_PENDING_DRAFTS - 1)).toBe(false);
    expect(isPendingCapReached(MAX_PENDING_DRAFTS)).toBe(true);
    expect(isPendingCapReached(MAX_PENDING_DRAFTS + 1)).toBe(true);
  });
});
