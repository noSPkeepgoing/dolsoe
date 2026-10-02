import { describe, expect, it } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";

import { countPendingDrafts, listCoveredProducts, openDb } from "../db.js";

import { createDraftStore } from "./store.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const product = (id: string): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: "https://example.com/" + id,
  priceKrw: 1000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});
const body: DraftBody = { category: "book", title: "t", intro: "i", items: [{ productExternalId: "1", oneLiner: "o", reason: "r" }], experienceLine: null };

describe("createDraftStore", () => {
  it("[REQ-001][REQ-003][REQ-004] 초안 저장은 초안·다룬 상품·마지막 카테고리를 함께 기록한다", () => {
    const db = openDb(":memory:");
    const store = createDraftStore(db, () => NOW);
    expect(store.getLastCategory()).toBeNull();
    expect(store.countPending()).toBe(0);

    const draft = store.saveDraft(
      { category: "book", mode: "daily", status: "awaiting_approval", products: [product("1")], body, memo: null, quality: null },
      [product("1")],
    );
    expect(draft.id).toBeGreaterThan(0);
    expect(store.getLastCategory()).toBe("book");
    expect(countPendingDrafts(db)).toBe(1);
    expect(listCoveredProducts(db).map((c) => c.externalId)).toEqual(["1"]);
  });

  it("[REQ-003] 저장 중 하나라도 실패하면 아무것도 남지 않는다(원자성)", () => {
    const db = openDb(":memory:");
    const store = createDraftStore(db, () => NOW);
    const broken = { ...product("1"), source: null } as unknown as Product; // markCovered에서 NOT NULL 위반
    expect(() =>
      store.saveDraft(
        { category: "book", mode: "daily", status: "awaiting_approval", products: [product("1")], body, memo: null, quality: null },
        [broken],
      ),
    ).toThrow();
    expect(countPendingDrafts(db)).toBe(0);
    expect(store.getLastCategory()).toBeNull();
  });

  it("[NFR-001] 이번 달 LLM 비용은 KST 월 기준으로 읽는다", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO llm_usage (month, estimated_cost_krw) VALUES (?, ?)").run("2026-10", 500);
    expect(createDraftStore(db, () => NOW).getMonthCostKrw()).toBe(500);
    expect(createDraftStore(db, () => new Date("2026-09-30T14:59:59Z")).getMonthCostKrw()).toBe(0);
  });
});
