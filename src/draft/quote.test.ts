import { describe, expect, it, vi } from "vitest";

import type { Product } from "@contract/domain.js";
import { QUOTE_MAX_CHARS } from "@contract/domain.js";

import { fitsQuote, gatherQuote, parseQuoteDirective, pickIntroQuote, pickWebQuote, stripQuoteLine, type QuoteCollector } from "./quote.js";

const book = (introduction: string | null = null): Product => ({
  externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "달의 정원", url: "https://www.yes24.com/addon/1",
  priceKrw: 15000, priceAsOf: "2026-10-24T00:00:00.000Z", specs: { 저자: "김서연" }, bookDetail: { introduction, tableOfContents: null },
});

const SENTENCE = "오늘 하루도 충분히 애썼어요.";
const sites = (text: string, n = 2) => Array.from({ length: n }, (_, i) => ({ url: `https://site${i}.example/p`, excerpt: `…${text}…` }));

describe("fitsQuote", () => {
  it("[REQ-029] 1~2문장·100자 이내·URL 없음만 통과한다", () => {
    expect(fitsQuote(SENTENCE)).toBe(true);
    expect(fitsQuote("하나. 둘.")).toBe(true);
    expect(fitsQuote("하나. 둘. 셋.")).toBe(false);
    expect(fitsQuote("가".repeat(QUOTE_MAX_CHARS + 1))).toBe(false);
    expect(fitsQuote("https://a.example 를 보세요")).toBe(false);
    expect(fitsQuote("  ")).toBe(false);
  });
});

describe("parseQuoteDirective / stripQuoteLine", () => {
  it("[REQ-029] '문구: …' 줄은 감싼 따옴표만 떼고 그대로 읽고, '없음'은 지우기, 줄이 없으면 none", () => {
    expect(parseQuoteDirective("메모\n문구: “좋은 문장이에요.”")).toEqual({ kind: "set", text: "좋은 문장이에요." });
    expect(parseQuoteDirective("필사： 문장")).toEqual({ kind: "set", text: "문장" });
    expect(parseQuoteDirective("문구: 없음")).toEqual({ kind: "clear" });
    expect(parseQuoteDirective("그냥 메모")).toEqual({ kind: "none" });
    expect(parseQuoteDirective("문구:")).toEqual({ kind: "none" });
  });

  it("[REQ-029] 메모에서 문구 줄만 빼고, 남는 게 없으면 null", () => {
    expect(stripQuoteLine("잔잔한 책이면 좋겠어요\n문구: 문장")).toBe("잔잔한 책이면 좋겠어요");
    expect(stripQuoteLine("문구: 문장")).toBeNull();
  });
});

describe("pickWebQuote", () => {
  const product = book();

  it("[REQ-029] 2곳에 글자 그대로 있는 문장만 인용되고 '— 『제목』, 저자'가 붙는다 (1곳뿐인 문장은 버린다)", () => {
    const only1 = "혼자만 아는 문장이에요.";
    const found = { candidates: [only1, SENTENCE], evidence: [...sites(SENTENCE), { url: "https://site9.example/p", excerpt: only1 }] };
    const picked = pickWebQuote(found, product)!;
    expect(picked.quote).toEqual({ text: SENTENCE, attribution: "— 『달의 정원』, 김서연", origin: "web" });
    expect(picked.urls).toHaveLength(2);
  });

  it("[REQ-029] 발췌에 없는 문장(모델 기억)과 길이 초과 문장은 쓰지 않는다", () => {
    expect(pickWebQuote({ candidates: ["기억에서 꺼낸 문장이에요."], evidence: sites(SENTENCE) }, product)).toBeNull();
    const long = "가".repeat(QUOTE_MAX_CHARS + 5);
    expect(pickWebQuote({ candidates: [long], evidence: sites(long) }, product)).toBeNull();
  });
});

describe("pickIntroQuote", () => {
  it("[REQ-029] 추천사(따옴표+대시 이름)는 '— 이름(직함)'으로 출처를 밝힌다", () => {
    const intro = "소개 문단입니다. “조용한 밤에 어울리는 책이에요” - 박민수(작가) 그리고 더 많은 설명.";
    expect(pickIntroQuote(book(intro))).toEqual({ text: "조용한 밤에 어울리는 책이에요", attribution: "— 박민수(작가)", origin: "intro" });
  });

  it("[REQ-029] 추천사가 없으면 소개문 문장을 '— 『제목』 소개글 중'으로 정직하게 표기한다 (글자 그대로)", () => {
    const intro = "한 사람이 일상의 작은 순간들을 따라가는 이야기예요. 다른 문장도 있어요.";
    const quote = pickIntroQuote(book(intro))!;
    expect(quote.attribution).toBe("— 『달의 정원』 소개글 중");
    expect(intro).toContain(quote.text);
    expect(quote.origin).toBe("intro");
  });

  it("[REQ-029] 소개문이 없거나 쓸 문장이 없으면 null (코너 생략)", () => {
    expect(pickIntroQuote(book(null))).toBeNull();
    expect(pickIntroQuote(book("짧음."))).toBeNull();
    expect(pickIntroQuote({ ...book(), bookDetail: undefined })).toBeNull();
  });
});

describe("gatherQuote — 우선순위 4경로", () => {
  const collector = (found: { candidates: string[]; evidence: { url: string; excerpt: string }[] }): QuoteCollector => ({ collect: vi.fn(async () => found) });
  const intro = "한 사람이 일상의 작은 순간들을 따라가는 이야기예요.";

  it("[REQ-029] ① 사용자 문구가 있으면 검색하지 않고 그걸 쓴다", async () => {
    const c = collector({ candidates: [SENTENCE], evidence: sites(SENTENCE) });
    const result = await gatherQuote("book", [book(intro)], "내가 고른 문장", c);
    expect(result.quote).toMatchObject({ text: "내가 고른 문장", origin: "user", attribution: "— 『달의 정원』, 김서연" });
    expect(c.collect).not.toHaveBeenCalled();
  });

  it("[REQ-029] ② 웹 2곳 확인 문장이 소개문보다 먼저고 출처 URL이 따라온다", async () => {
    const result = await gatherQuote("book", [book(intro)], null, collector({ candidates: [SENTENCE], evidence: sites(SENTENCE) }));
    expect(result.quote?.origin).toBe("web");
    expect(result.quoteSources).toHaveLength(2);
  });

  it("[REQ-029] ②가 1곳만 확인이면 ③ 소개문으로 내려간다", async () => {
    const result = await gatherQuote("book", [book(intro)], null, collector({ candidates: [SENTENCE], evidence: sites(SENTENCE, 1) }));
    expect(result.quote?.origin).toBe("intro");
    expect(result.quoteSources).toBeUndefined();
  });

  it("[REQ-029] ④ 웹도 소개문도 없으면 quote null (카드가 문구를 요청한다)", async () => {
    const result = await gatherQuote("book", [book(null)], null, collector({ candidates: [], evidence: [] }));
    expect(result).toEqual({ quote: null });
  });

  it("[REQ-029] 수집이 실패해도 소개문으로 계속한다", async () => {
    const onFailure = vi.fn();
    const failing: QuoteCollector = { collect: async () => { throw new Error("검색 장애"); } };
    const result = await gatherQuote("book", [book(intro)], null, failing, onFailure);
    expect(result.quote?.origin).toBe("intro");
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("검색 장애"));
  });

  it("[REQ-029] 가전은 필사 문구를 만들지 않는다", async () => {
    expect(await gatherQuote("appliance", [book(intro)], null, undefined)).toEqual({ quote: null });
  });
});
