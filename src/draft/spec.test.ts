import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";

import { confirmSpecs, gatherSpecs, type SpecCollector } from "./spec.js";

const product = (id: string, specs: Record<string, string> = {}): Product => ({
  externalId: id,
  source: "coupang_link",
  category: "appliance",
  affiliate: "coupang",
  title: `${id} 에어프라이어`,
  url: `https://link.coupang.com/a/${id}`,
  priceKrw: 50000,
  priceAsOf: "2026-10-24T00:00:00.000Z",
  specs,
});

const two = (value: string) => [
  { url: "https://a.example/1", excerpt: `용량 ${value}` },
  { url: "https://b.example/1", excerpt: `${value} 대용량` },
];

describe("confirmSpecs", () => {
  it("[REQ-028] 2곳에서 글자 그대로 확인된 후보만 스펙이 되고 출처 URL이 따라온다", () => {
    const result = confirmSpecs({ candidates: [{ key: "용량", value: "3.5L" }], evidence: two("3.5L") });
    expect(result).toEqual({ specs: { 용량: "3.5L" }, urls: ["https://a.example/1", "https://b.example/1"] });
  });

  it("[REQ-028] 1곳만 확인되거나 발췌에 없는 후보는 버린다", () => {
    expect(confirmSpecs({ candidates: [{ key: "용량", value: "3.5L" }], evidence: [two("3.5L")[0]!] }).specs).toEqual({});
    expect(confirmSpecs({ candidates: [{ key: "용량", value: "9L" }], evidence: two("3.5L") }).specs).toEqual({});
  });
});

describe("gatherSpecs", () => {
  const collector = (impl: SpecCollector["collect"]): SpecCollector => ({ collect: vi.fn(impl) });

  it("[REQ-028] 사용자가 적은 스펙이 우선이라 그 항목은 검색하지 않는다", async () => {
    const c = collector(async () => ({ candidates: [{ key: "용량", value: "9L" }], evidence: two("9L") }));
    const result = await gatherSpecs("appliance", [product("A", { 용량: "3.5L" })], c);
    expect(c.collect).not.toHaveBeenCalled();
    expect(result.products[0]!.specs).toEqual({ 용량: "3.5L" });
    expect(result.specOrigin).toEqual({ user: 1, web: 0 });
  });

  it("[REQ-028] 빈 항목만 웹 2곳 확인값으로 채우고 출처와 개수를 남긴다", async () => {
    const c = collector(async () => ({ candidates: [{ key: "용량", value: "5L" }], evidence: two("5L") }));
    const result = await gatherSpecs("appliance", [product("A", { 용량: "3.5L" }), product("B")], c);
    expect(result.products.map((p) => p.specs["용량"])).toEqual(["3.5L", "5L"]);
    expect(result.specSources).toEqual(["https://a.example/1", "https://b.example/1"]);
    expect(result.specOrigin).toEqual({ user: 1, web: 1 });
  });

  it("[REQ-028] 확인 못 한 항목은 비워 둔다(판단 안 함) — 출처도 남기지 않는다", async () => {
    const c = collector(async () => ({ candidates: [{ key: "용량", value: "5L" }], evidence: [two("5L")[0]!] }));
    const result = await gatherSpecs("appliance", [product("A")], c);
    expect(result.products[0]!.specs).toEqual({});
    expect(result.specSources).toBeUndefined();
    expect(result.specOrigin).toEqual({ user: 0, web: 0 });
  });

  it("[REQ-028] 수집이 실패해도 초안은 계속 만든다(그 상품만 스펙 없음)", async () => {
    const onFailure = vi.fn();
    const c = collector(async () => {
      throw new Error("검색 장애");
    });
    const result = await gatherSpecs("appliance", [product("A")], c, onFailure);
    expect(result.products[0]!.specs).toEqual({});
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("검색 장애"));
  });

  it("[REQ-028] 책이거나 수집기가 없으면 검색하지 않는다", async () => {
    const c = collector(async () => ({ candidates: [], evidence: [] }));
    await gatherSpecs("book", [product("A")], c);
    await gatherSpecs("appliance", [product("A")], undefined);
    expect(c.collect).not.toHaveBeenCalled();
  });
});
