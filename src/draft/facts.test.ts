import { describe, expect, it } from "vitest";

import type { ApplianceBody, Product } from "@contract/domain.js";

import { computeFacts, factLinesFor, findFactProblems, householdFor, parseLiters } from "./facts.js";

const product = (id: string, priceKrw: number | null, capacity?: string): Product => ({
  externalId: id,
  source: "coupang_link",
  category: "appliance",
  affiliate: "coupang",
  title: `${id} 에어프라이어`,
  url: `https://link.coupang.com/a/${id}`,
  priceKrw,
  priceAsOf: priceKrw === null ? null : "2026-10-24T00:00:00.000Z",
  specs: capacity === undefined ? {} : { 용량: capacity },
});

const body = (recs: ApplianceBody["recommendations"], verdict = "결론"): ApplianceBody => ({
  category: "appliance",
  title: "t",
  verdict,
  comparison: { headers: ["제품", "가격"], rows: [["a", "1"]] },
  recommendations: recs,
  experienceLine: null,
});

describe("parseLiters / householdFor", () => {
  it("[REQ-028] L·리터·ml 표기를 리터로 읽고, 읽을 수 없으면 null", () => {
    expect(parseLiters("3.5L")).toBe(3.5);
    expect(parseLiters("5 리터")).toBe(5);
    expect(parseLiters("800ml")).toBe(0.8);
    expect(parseLiters("크다")).toBeNull();
    expect(parseLiters(undefined)).toBeNull();
  });

  it("[REQ-028] 가구 수 적합 범위는 매핑 표로 정한다", () => {
    expect([3, 3.5, 4, 5, 6, 8].map(householdFor)).toEqual(["1~2인", "1~2인", "2~3인", "2~3인", "3~4인", "4인 이상"]);
  });
});

describe("computeFacts", () => {
  it("[REQ-028] 용량 3개를 입력하면 용량 1위·리터당 가격 최저·가구 수 팩트가 계산된다", () => {
    const facts = computeFacts([product("A", 59000, "3.5L"), product("B", 89000, "5L"), product("C", 129000, "12L")]);
    const text = (id: string) => facts.find((f) => f.id === id)?.text;
    expect(text("capacity_max")).toBe("용량이 가장 큰 제품은 C 에어프라이어(12L)");
    expect(text("price_per_liter_min")).toBe("리터당 가격이 가장 낮은 제품은 C 에어프라이어(리터당 10,750원)");
    expect(text("price_min")).toBe("가격이 가장 낮은 제품은 A 에어프라이어(59,000원)");
    expect(text("household:A")).toContain("1~2인");
    expect(text("household:C")).toContain("4인 이상");
  });

  it("[REQ-028] 가격만 입력하면 용량·리터당 가격 판단은 만들지 않는다", () => {
    const ids = computeFacts([product("A", 59000), product("B", 89000)]).map((f) => f.id);
    expect(ids).toEqual(["price_min"]);
  });

  it("[REQ-028] 용량이 한 제품뿐이면 비교(1위)는 없고 그 제품의 가구 수 팩트만 남는다", () => {
    expect(computeFacts([product("A", 59000, "3.5L"), product("B", 89000)]).map((f) => f.id)).toEqual(["price_min", "household:A"]);
  });

  it("[REQ-028] 스펙도 가격도 없으면 팩트가 없다", () => {
    expect(computeFacts([product("A", null), product("B", null)])).toEqual([]);
  });
});

describe("findFactProblems", () => {
  const products = [product("A", 59000, "3.5L"), product("B", 89000, "5L")];
  const facts = computeFacts(products);
  const rec = (reason: string, factIds?: string[]) => ({ forWhom: "1인가구", productExternalId: "A", reason, ...(factIds === undefined ? {} : { factIds }) });

  it("[REQ-028] 존재하지 않는 팩트 ID는 문제로 잡는다", () => {
    expect(findFactProblems(body([rec("좋아요", ["capacity_max", "nope"])]), products, facts)).toEqual([expect.stringContaining('"nope"')]);
  });

  it("[REQ-028] 팩트·스펙·가격에 있는 수치는 통과하고, 없는 수치는 문제로 잡는다", () => {
    expect(findFactProblems(body([rec("3.5L라 1인 가구라면 딱 맞을 것 같아요. 5만9천원이 아니라 59,000원이에요")]), products, facts)).toEqual([]);
    expect(findFactProblems(body([rec("용량이 10L라 넉넉할 것 같아요")]), products, facts)).toEqual([expect.stringContaining("10L")]);
    expect(findFactProblems(body([rec("가격은 1,000원이에요")], "결론"), products, facts)).toHaveLength(1);
  });

  it("[REQ-028] 단위 없는 숫자(3종·1인)는 판단 수치로 세지 않는다", () => {
    expect(findFactProblems(body([rec("1인 가구에 3종 중 가장 가벼워요")]), products, facts)).toEqual([]);
  });
});

describe("findFactProblems — 본문 전체·단위 비교", () => {
  const products = [product("A", 59000, "3.5L"), product("B", 89000, "5L")];
  const facts = computeFacts(products);
  const rec = (reason: string) => ({ forWhom: "1인가구", productExternalId: "A", reason });
  const withTable = (rows: string[][], extra: Partial<ApplianceBody> = {}): ApplianceBody => ({ ...body([rec("좋을 것 같아요")]), comparison: { headers: ["제품", "가격", "용량"], rows }, ...extra });

  it("[REQ-028] 비교표 셀의 지어낸 수치도 잡는다", () => {
    expect(findFactProblems(withTable([["A", "59,000원", "6L"]]), products, facts)).toEqual([expect.stringContaining("6L")]);
    expect(findFactProblems(withTable([["A", "59,000원", "3.5L"], ["B", "89,000원", "5L"]]), products, facts)).toEqual([]);
  });

  it("[REQ-028] 도입·마무리의 지어낸 수치도 잡는다", () => {
    expect(findFactProblems(withTable([["A", "59,000원", "3.5L"]], { intro: "7L짜리도 있어요" }), products, facts)).toEqual([expect.stringContaining("7L")]);
    expect(findFactProblems(withTable([["A", "59,000원", "3.5L"]], { closing: "10만원 안쪽이에요" }), products, facts)).toEqual([expect.stringContaining("10만원")]);
  });

  it("[REQ-028] 숫자만이 아니라 단위까지 같아야 한다(3.5kg은 3.5L가 아님)", () => {
    expect(findFactProblems(body([rec("3.5kg이라 가벼울 것 같아요")]), products, facts)).toEqual([expect.stringContaining("3.5kg")]);
    expect(findFactProblems(body([rec("5만원이에요")]), products, facts)).toEqual([expect.stringContaining("5만원")]);
  });

  it("[REQ-028] 가격은 59,000원·5.9만원 두 표기 모두 허용하고, 리터·ℓ·ml 표기도 같은 값으로 본다", () => {
    expect(findFactProblems(body([rec("5.9만원, 3.5 리터, 3500ml예요")]), products, facts)).toEqual([]);
  });

  it("[REQ-028] 사용자 경험 문장의 숫자는 검사하지 않는다", () => {
    expect(findFactProblems(withTable([["A", "59,000원", "3.5L"]], { experienceLine: "저는 12L를 써요" }), products, facts)).toEqual([]);
  });
});

describe("factLinesFor", () => {
  it("[REQ-028] 가리킨 팩트의 수치 문장만 돌려준다(없는 ID는 건너뜀)", () => {
    const facts = computeFacts([product("A", 59000, "3.5L"), product("B", 89000, "5L")]);
    expect(factLinesFor(["capacity_max", "nope"], facts)).toEqual(["용량이 가장 큰 제품은 B 에어프라이어(5L)"]);
    expect(factLinesFor(undefined, facts)).toEqual([]);
  });
});
