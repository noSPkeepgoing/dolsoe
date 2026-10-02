import { describe, expect, it, vi } from "vitest";

import { Yes24ApiError, Yes24Source, parseYes24Items } from "./yes24.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sortOrder: 1,
  itemId: 900000001,
  title: "달빛 서점의 하루",
  author: "김서연",
  goodsType: "일반",
  goodsSortNm: "국내도서",
  adultYn: "N",
  publisher: "하늘책방",
  isbn10: "",
  isbn13: "9791190000015",
  shopPrice: 16800,
  salePrice: 15120,
  publishDate: "2026-05-12",
  itemStatus: "판매중",
  cover: "https://image.yes24.com/a.jpg",
  link: "https://www.yes24.com/Product/Goods/900000001",
  addOnLink: "https://www.yes24.com/Product/Goods/900000001?addon=abc",
  upDown: 2,
  contentDetail: null,
  ...over,
});

const envelope = (items: unknown[]): unknown => ({
  success: true,
  message: "성공",
  data: { meta: { apiTitle: "종합 베스트셀러 조회", pubDate: "2026-10-01T00:00:00+09:00", version: "v1" }, items },
});

describe("parseYes24Items", () => {
  it("[ADR-009] 응답 항목을 Product로 바꾼다: 수익 링크(addOnLink)·판매가·기준일·스펙", () => {
    const [product] = parseYes24Items(envelope([item()]), NOW);
    expect(product).toEqual({
      externalId: "900000001",
      source: "yes24",
      category: "book",
      affiliate: "yes24",
      title: "달빛 서점의 하루",
      url: "https://www.yes24.com/Product/Goods/900000001?addon=abc",
      priceKrw: 15120,
      priceAsOf: NOW.toISOString(),
      specs: { 저자: "김서연", 출판사: "하늘책방", 정가: "16800", 출간일: "2026-05-12", ISBN: "9791190000015" },
    });
  });

  it("[REQ-005] 성인물·판매중이 아닌 상품·수익 링크가 없는 상품은 후보에서 뺀다", () => {
    const items = [
      item({ itemId: 1 }),
      item({ itemId: 2, adultYn: "Y" }),
      item({ itemId: 3, itemStatus: "품절" }),
      item({ itemId: 4, addOnLink: "" }),
      item({ itemId: 5 }),
    ];
    expect(parseYes24Items(envelope(items), NOW).map((p) => p.externalId)).toEqual(["1", "5"]);
  });

  it("[ADR-009] 응답 순서(순위)를 유지한다", () => {
    const items = [item({ itemId: 30 }), item({ itemId: 10 }), item({ itemId: 20 })];
    expect(parseYes24Items(envelope(items), NOW).map((p) => p.externalId)).toEqual(["30", "10", "20"]);
  });

  it("[ADR-009] 필수 필드가 빠졌거나 모양이 다르면 조용히 넘기지 않고 실패한다(경계 검증)", () => {
    expect(() => parseYes24Items(envelope([{ itemId: 1 }]), NOW)).toThrow();
    expect(() => parseYes24Items({ nope: true }, NOW)).toThrow();
  });
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Yes24Source", () => {
  const make = (fetchFn: typeof fetch): Yes24Source => new Yes24Source({ apiKey: "yk_test", fetchFn, now: () => NOW });

  it("[ADR-009] 도서만 자동으로 준다", () => {
    expect(make(vi.fn() as unknown as typeof fetch).categories).toEqual(["book"]);
  });

  it("[ADR-009] 종합 베스트셀러를 X-Api-Key 헤더로 요청하고 상품 목록을 돌려준다", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, envelope([item()])));
    const products = await make(fetchFn as unknown as typeof fetch).fetchCandidates("book");
    expect(products).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/apis\.yes24\.com\/v1\/category\/bestseller\?/);
    expect(new Headers(init.headers).get("X-Api-Key")).toBe("yk_test");
  });

  it("[REQ-005] 결과 없음(404 BEST_001)은 오류가 아니라 빈 목록이다", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(404, { success: false, errorCode: "BEST_001", message: "베스트셀러 결과가 없습니다.", data: null }),
    );
    expect(await make(fetchFn as unknown as typeof fetch).fetchCandidates("book")).toEqual([]);
  });

  it("[REQ-005] 인증 오류·호출 한도 초과는 오류 코드를 담아 실패한다(조용히 빈 목록으로 숨기지 않음)", async () => {
    const auth = vi.fn(async () => jsonResponse(401, { success: false, errorCode: "AUTH_002", message: "유효하지 않은 API Key입니다.", data: null }));
    await expect(make(auth as unknown as typeof fetch).fetchCandidates("book")).rejects.toMatchObject({
      name: "Yes24ApiError",
      errorCode: "AUTH_002",
      status: 401,
    });
    const rate = vi.fn(async () => jsonResponse(429, { success: false, errorCode: "RATE_002", message: "일일 한도", data: null }, { "Retry-After": "30" }));
    await expect(make(rate as unknown as typeof fetch).fetchCandidates("book")).rejects.toBeInstanceOf(Yes24ApiError);
  });

  it("[REQ-005] 지원하지 않는 카테고리를 요청하면 실패한다", async () => {
    await expect(make(vi.fn() as unknown as typeof fetch).fetchCandidates("appliance")).rejects.toThrow(/appliance/);
  });
});
