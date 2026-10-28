import { describe, expect, it } from "vitest";

import { coupangLinkToProduct, parseLinkMessage } from "./link-parser.js";

const COUPANG = "https://link.coupang.com/a/abc123";

describe("parseLinkMessage", () => {
  it("[REQ-006] 링크가 없는 메시지는 링크 모드가 아니다", () => {
    expect(parseLinkMessage("안녕")).toEqual({ kind: "none" });
  });

  it("[REQ-006] 쿠팡 파트너스 링크 + 다음 줄 상품명/가격 + 나머지는 메모", () => {
    const parsed = parseLinkMessage(`${COUPANG}\n삼성 비스포크 제트 / 899,000원\n30평대 아파트, 소음 중요`);
    expect(parsed).toEqual({
      kind: "ok",
      links: [{ type: "coupang", url: COUPANG, code: "abc123", title: "삼성 비스포크 제트", priceKrw: 899000, specs: {} }],
      memo: "30평대 아파트, 소음 중요",
    });
  });

  it("[REQ-006] 가격 없이 상품명만 줘도 된다(가격 null)", () => {
    const parsed = parseLinkMessage(`${COUPANG}\n로보락 S9`);
    expect(parsed).toMatchObject({ kind: "ok", links: [{ title: "로보락 S9", priceKrw: null }], memo: null });
  });

  it("[REQ-006] 같은 줄에 링크와 상품명을 같이 써도 된다", () => {
    expect(parseLinkMessage(`${COUPANG} 로보락 S9 500000원`)).toMatchObject({
      kind: "ok",
      links: [{ title: "로보락 S9", priceKrw: 500000 }],
    });
  });

  it("[REQ-006] 쿠팡 링크에 상품명이 없으면 상품명을 요청한다(페이지를 긁지 않는다 — ADR-008)", () => {
    expect(parseLinkMessage(COUPANG)).toEqual({ kind: "missing_title", url: COUPANG });
  });

  it("[REQ-006] 링크를 여러 개 보내면 각자의 다음 줄이 그 링크의 상품명이다", () => {
    const parsed = parseLinkMessage(`${COUPANG}\n제품 A / 100000원\nhttps://link.coupang.com/a/zzz999\n제품 B\n비교해줘`);
    expect(parsed).toMatchObject({
      kind: "ok",
      links: [{ code: "abc123", title: "제품 A", priceKrw: 100000 }, { code: "zzz999", title: "제품 B", priceKrw: null }],
      memo: "비교해줘",
    });
  });

  it("[REQ-006] YES24 상품 링크는 상품번호만 뽑는다(상품명은 API가 채운다)", () => {
    for (const url of [
      "https://www.yes24.com/Product/Goods/12345678",
      "https://yes24.com/product/goods/12345678?pid=1",
      "https://m.yes24.com/Goods/Detail/12345678",
    ]) {
      expect(parseLinkMessage(url)).toEqual({ kind: "ok", links: [{ type: "yes24", url, itemId: "12345678" }], memo: null });
    }
  });

  it("[REQ-006] 지원하지 않는 링크(일반 쿠팡 상품 URL·다른 사이트·비슷한 도메인)는 안내 대상이다", () => {
    for (const url of [
      "https://www.coupang.com/vp/products/123", // 파트너 링크가 아니라 수익 없음
      "https://example.com/a",
      "https://link.coupang.com.evil.example/a/abc",
      "https://notyes24.com/Product/Goods/123",
    ]) {
      expect(parseLinkMessage(url)).toEqual({ kind: "unsupported", urls: [url] });
    }
  });

  it("[REQ-006] http·계정정보·포트가 붙은 링크는 지원하지 않는다(구매 링크로 그대로 내보내지 않음)", () => {
    for (const url of ["http://link.coupang.com/a/abc", "https://user:pw@link.coupang.com/a/abc", "https://link.coupang.com:8080/a/abc"]) {
      expect(parseLinkMessage(url)).toEqual({ kind: "unsupported", urls: [url] });
    }
  });

  it("[REQ-006] 쿠팡 링크는 쿼리를 떼고 정규화하며, 한글이 바로 붙어도 링크에 섞이지 않는다", () => {
    expect(parseLinkMessage("https://link.coupang.com/a/abc123?x=1 로보락 S9")).toMatchObject({
      links: [{ url: "https://link.coupang.com/a/abc123", code: "abc123", title: "로보락 S9" }],
    });
    expect(parseLinkMessage("https://coupa.ng/abc삼성청소기")).toMatchObject({ kind: "ok", links: [{ code: "abc" }] });
  });

  it("[REQ-006] 지원 링크와 지원하지 않는 링크가 섞이면 안내 대상이다", () => {
    expect(parseLinkMessage(`${COUPANG}\n제품\nhttps://example.com/a`)).toMatchObject({ kind: "unsupported" });
  });
});

describe("parseLinkMessage — 스펙 토큰 (REQ-028)", () => {
  it("[REQ-028] `키 값` 조각은 스펙이 되고 맨 숫자는 가격이 되며 상품명만 남는다", () => {
    expect(parseLinkMessage(`${COUPANG}\n에어프라이어 A / 59000 / 용량 3.5L`)).toMatchObject({
      kind: "ok",
      links: [{ title: "에어프라이어 A", priceKrw: 59000, specs: { 용량: "3.5L" } }],
    });
  });

  it("[REQ-028] 원 표기 가격과 스펙을 섞어도 된다", () => {
    expect(parseLinkMessage(`${COUPANG}\n에어프라이어 B / 89,000원 / 용량 5L / 소비전력 1500W`)).toMatchObject({
      links: [{ title: "에어프라이어 B", priceKrw: 89000, specs: { 용량: "5L", 소비전력: "1500W" } }],
    });
  });

  it("[REQ-028] 알려진 키가 아니면 스펙이 아니라 상품명의 일부다(숫자가 섞인 상품명 보호)", () => {
    expect(parseLinkMessage(`${COUPANG}\nLG 퓨리케어 360 / 300000원`)).toMatchObject({
      links: [{ title: "LG 퓨리케어 360", priceKrw: 300000, specs: {} }],
    });
  });

  it("[REQ-028] 상품명 안의 '/'는 원문 그대로 보존한다(A/B가 'A / B'로 바뀌지 않음)", () => {
    expect(parseLinkMessage(`${COUPANG}\nA/B 에어프라이어 / 59000 / 용량 3.5L`)).toMatchObject({
      links: [{ title: "A/B 에어프라이어", priceKrw: 59000, specs: { 용량: "3.5L" } }],
    });
    expect(parseLinkMessage(`${COUPANG}\n통돌이 / 건조기 세트 / 59000`)).toMatchObject({ links: [{ title: "통돌이 / 건조기 세트", priceKrw: 59000 }] });
  });

  it("[REQ-028] 맨 앞(상품명 자리)의 키 단어·숫자는 스펙·가격으로 먹지 않는다", () => {
    expect(parseLinkMessage(`${COUPANG}\n용량 큰 에어프라이어 / 59000`)).toMatchObject({ links: [{ title: "용량 큰 에어프라이어", priceKrw: 59000, specs: {} }] });
    expect(parseLinkMessage(`${COUPANG}\n2024 신형 에어프라이어`)).toMatchObject({ links: [{ title: "2024 신형 에어프라이어", priceKrw: null }] });
    expect(parseLinkMessage(`${COUPANG}\n2024`)).toMatchObject({ links: [{ title: "2024", priceKrw: null }] });
  });

  it("[REQ-028] 상품명 뒤쪽 조각의 `키 값`은 여전히 스펙이다", () => {
    expect(parseLinkMessage(`${COUPANG}\n에어프라이어 / 용량 큼`)).toMatchObject({ links: [{ title: "에어프라이어", specs: { 용량: "큼" } }] });
  });

  it("[REQ-028] 스펙을 안 적으면 specs는 비어 있다", () => {
    expect(parseLinkMessage(`${COUPANG}\n로보락 S9`)).toMatchObject({ links: [{ specs: {} }] });
  });

  it("[REQ-028] 사용자가 적은 스펙이 상품의 specs로 들어간다", () => {
    const parsed = parseLinkMessage(`${COUPANG}\n에어프라이어 A / 용량 3.5L`);
    if (parsed.kind !== "ok" || parsed.links[0]?.type !== "coupang") throw new Error("unexpected");
    expect(coupangLinkToProduct(parsed.links[0], new Date("2026-10-02T00:00:00.000Z")).specs).toEqual({ 용량: "3.5L" });
  });
});

describe("coupangLinkToProduct", () => {
  const NOW = new Date("2026-10-02T00:00:00.000Z");

  it("[REQ-006][REQ-011] 가격을 줬으면 기준일(지금)과 함께, 안 줬으면 둘 다 null로 가전 상품을 만든다", () => {
    const withPrice = coupangLinkToProduct({ type: "coupang", url: COUPANG, code: "abc123", title: "로보락 S9", priceKrw: 500000, specs: {} }, NOW);
    expect(withPrice).toEqual({
      externalId: "abc123",
      source: "coupang_link",
      category: "appliance",
      affiliate: "coupang",
      title: "로보락 S9",
      url: COUPANG,
      priceKrw: 500000,
      priceAsOf: NOW.toISOString(),
      specs: {},
    });
    expect(coupangLinkToProduct({ type: "coupang", url: COUPANG, code: "abc123", title: "로보락 S9", priceKrw: null, specs: {} }, NOW)).toMatchObject({
      priceKrw: null,
      priceAsOf: null,
    });
  });
});
