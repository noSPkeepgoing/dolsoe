import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";

import { collectReviewsSafely, gatherReviews, type ReviewCollector } from "./review.js";

const product: Product = {
  externalId: "1",
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: "가호",
  url: "https://www.yes24.com/addon/1",
  priceKrw: null,
  priceAsOf: null,
  specs: {},
};

describe("collectReviewsSafely", () => {
  it("[REQ-016] 수집에 성공하면 근거를 그대로 돌려준다", async () => {
    const collector: ReviewCollector = { collect: async () => ({ notes: "- 메모", sources: ["https://blog.example.com/a"] }) };
    expect(await collectReviewsSafely(collector, product)).toEqual({ notes: "- 메모", sources: ["https://blog.example.com/a"] });
  });

  it("[REQ-016] 수집이 실패하면 예외 대신 '후기 근거 없음'으로 계속하고 이유를 알린다(초안을 막지 않는다)", async () => {
    const collector: ReviewCollector = { collect: async () => { throw new Error("검색 서버 오류"); } };
    const onFailure = vi.fn();
    expect(await collectReviewsSafely(collector, product, onFailure)).toEqual({ notes: "", sources: [] });
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("검색 서버 오류"));
  });

  it("[REQ-016] 수집기가 없으면(후기 기능 끔) 바로 '후기 근거 없음'", async () => {
    expect(await collectReviewsSafely(undefined, product)).toEqual({ notes: "", sources: [] });
  });
});

describe("gatherReviews", () => {
  const collector: ReviewCollector = { collect: async () => ({ notes: "- 메모", sources: ["https://blog.example.com/a"], excerpts: ["원문 조각"] }) };

  it("[REQ-016] 책이면 노트·출처·원문 조각을 돌려주고, 가전이면 아무것도 수집하지 않는다", async () => {
    expect(await gatherReviews("book", [product], collector)).toEqual({
      reviewNotes: "- 메모",
      reviewSources: ["https://blog.example.com/a"],
      reviewExcerpts: ["원문 조각"],
    });
    expect(await gatherReviews("appliance", [product], collector)).toEqual({});
  });

  it("[REQ-016] 책인데 근거가 없으면 노트·원문 조각 없이 출처만 빈 목록으로 남긴다(카드: 후기 근거 없음)", async () => {
    expect(await gatherReviews("book", [product], undefined)).toEqual({ reviewSources: [] });
  });

  it("[REQ-016] 노트가 비면 출처가 남아 있어도 '후기 N건 참고'가 뜨지 않게 출처를 비운다", async () => {
    const odd: ReviewCollector = { collect: async () => ({ notes: "  ", sources: ["https://shop.example.com/a"], excerpts: ["조각"] }) };
    expect(await gatherReviews("book", [product], odd)).toEqual({ reviewSources: [] });
  });
});
