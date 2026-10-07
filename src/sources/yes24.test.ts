import { describe, expect, it, vi } from "vitest";

import { BOOK_CANDIDATE_CATEGORY_IDS, BOOK_DETAIL_MAX_CHARS } from "@contract/domain.js";

import { Yes24ApiError, Yes24LinkError, Yes24Source, parseYes24Items } from "./yes24.js";

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

  it("[REQ-002] contentDetail의 소개문·목차를 HTML 태그·여분 공백을 걷어 bookDetail로 담는다", () => {
    const detail = { bookIntroduction: "<b>“좋은 이야기”</b> 란\n  무엇인가", bookSummary: null, tableOfContents: "1장 <b>· </b>시작   2장 끝" };
    const [product] = parseYes24Items(envelope([item({ contentDetail: detail })]), NOW);
    expect(product?.bookDetail).toEqual({ introduction: "“좋은 이야기” 란 무엇인가", tableOfContents: "1장 · 시작 2장 끝" });
  });

  it("[REQ-002] 소개문·목차가 길면 BOOK_DETAIL_MAX_CHARS로 자르고, 둘 다 비면 bookDetail을 두지 않는다", () => {
    const long = "가".repeat(BOOK_DETAIL_MAX_CHARS + 500);
    const [cut] = parseYes24Items(envelope([item({ contentDetail: { bookIntroduction: long, bookSummary: null, tableOfContents: null } })]), NOW);
    expect(cut?.bookDetail?.introduction?.length).toBeLessThanOrEqual(BOOK_DETAIL_MAX_CHARS);
    expect(cut?.bookDetail?.tableOfContents).toBeNull();
    const [none] = parseYes24Items(envelope([item({ contentDetail: { bookIntroduction: " ", bookSummary: null, tableOfContents: null } })]), NOW);
    expect(none?.bookDetail).toBeUndefined();
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

  it("[REQ-001] 책 후보는 소설·에세이 카테고리별 베스트셀러를 X-Api-Key 헤더로 각각 요청한다(categoryId 필수 — 실서버 PARAM_001)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, envelope([item()])));
    await make(fetchFn as unknown as typeof fetch).fetchCandidates("book");
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    const ids = calls.map(([url]) => new URL(url).searchParams.get("categoryId"));
    expect(ids).toEqual([...BOOK_CANDIDATE_CATEGORY_IDS]);
    for (const [url, init] of calls) {
      expect(url).toMatch(/^https:\/\/apis\.yes24\.com\/v1\/category\/bestseller\?/);
      expect(new Headers(init.headers).get("X-Api-Key")).toBe("yk_test");
    }
  });

  it("[REQ-001] 두 카테고리 결과를 순위대로 번갈아 섞고 같은 책은 한 번만 준다", async () => {
    const byCategory: Record<string, unknown[]> = {
      [BOOK_CANDIDATE_CATEGORY_IDS[0]]: [item({ itemId: 1 }), item({ itemId: 2 }), item({ itemId: 9 })],
      [BOOK_CANDIDATE_CATEGORY_IDS[1]]: [item({ itemId: 10 }), item({ itemId: 9 }), item({ itemId: 11 })],
    };
    const fetchFn = vi.fn(async (url: string) => jsonResponse(200, envelope(byCategory[new URL(url).searchParams.get("categoryId") ?? ""] ?? [])));
    const products = await make(fetchFn as unknown as typeof fetch).fetchCandidates("book");
    expect(products.map((p) => p.externalId)).toEqual(["1", "10", "2", "9", "11"]);
  });

  it("[REQ-005] 한 카테고리만 결과 없음(404 BEST_001)이면 다른 카테고리 결과로 계속하고, 모두 없으면 빈 목록", async () => {
    const empty = () => jsonResponse(404, { success: false, errorCode: "BEST_001", message: "베스트셀러 결과가 없습니다.", data: null });
    const partial = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("categoryId") === BOOK_CANDIDATE_CATEGORY_IDS[0] ? empty() : jsonResponse(200, envelope([item({ itemId: 5 })])),
    );
    expect((await make(partial as unknown as typeof fetch).fetchCandidates("book")).map((p) => p.externalId)).toEqual(["5"]);
    expect(await make(vi.fn(async () => empty()) as unknown as typeof fetch).fetchCandidates("book")).toEqual([]);
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

describe("Yes24Source.fetchItem (링크 모드)", () => {
  const make = (fetchFn: typeof fetch): Yes24Source => new Yes24Source({ apiKey: "yk_test", fetchFn, now: () => NOW });

  it("[REQ-006] 상품번호로 상세를 조회해 수익 링크가 붙은 Product 한 개를 돌려준다", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, envelope([item()])));
    const product = await make(fetchFn as unknown as typeof fetch).fetchItem("900000001");
    expect(product).toMatchObject({ externalId: "900000001", url: "https://www.yes24.com/Product/Goods/900000001?addon=abc" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://apis.yes24.com/v1/goods/itemDetail?searchType=ItemId&query=900000001");
    expect(new Headers(init.headers).get("X-Api-Key")).toBe("yk_test");
  });

  it("[REQ-002] 링크 모드 상세 조회도 소개문·목차를 bookDetail로 담는다", async () => {
    const detail = { bookIntroduction: "소개문이에요", bookSummary: null, tableOfContents: "1장 시작" };
    const fetchFn = vi.fn(async () => jsonResponse(200, envelope([item({ contentDetail: detail })])));
    const product = await make(fetchFn as unknown as typeof fetch).fetchItem("900000001");
    expect(product.bookDetail).toEqual({ introduction: "소개문이에요", tableOfContents: "1장 시작" });
  });

  it("[REQ-006] 상품이 없거나(GOODS_001) 수익 링크가 없어 걸러지면 이유를 담아 Yes24LinkError", async () => {
    const missing = vi.fn(async () => jsonResponse(404, { success: false, errorCode: "GOODS_001", message: "상품 없음", data: null }));
    await expect(make(missing as unknown as typeof fetch).fetchItem("1")).rejects.toBeInstanceOf(Yes24LinkError);

    const noAddon = vi.fn(async () => jsonResponse(200, envelope([item({ addOnLink: "" })])));
    await expect(make(noAddon as unknown as typeof fetch).fetchItem("1")).rejects.toThrow(/수익 링크/);
  });

  it("[REQ-006] 인증 오류 등 그 밖의 API 오류는 그대로 Yes24ApiError", async () => {
    const auth = vi.fn(async () => jsonResponse(401, { success: false, errorCode: "AUTH_002", message: "유효하지 않은 API Key입니다.", data: null }));
    await expect(make(auth as unknown as typeof fetch).fetchItem("1")).rejects.toBeInstanceOf(Yes24ApiError);
  });
});
