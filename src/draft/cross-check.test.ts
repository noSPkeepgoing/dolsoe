import { describe, expect, it } from "vitest";

import { crossCheck, normalizeForCheck } from "./cross-check.js";

describe("crossCheck", () => {
  const ev = (url: string, excerpt: string) => ({ url, excerpt });

  it("[REQ-028] 서로 다른 사이트 2곳의 발췌에 글자 그대로 있으면 통과하고 사이트별 URL을 돌려준다", () => {
    const result = crossCheck("3.5L", [ev("https://a.example/p/1", "정격 용량 3.5L 모델"), ev("https://www.b.example/x", "용량: 3.5 L"), ev("https://b.example/y", "3.5L")]);
    expect(result.passed).toBe(true);
    expect(result.sites.sort()).toEqual(["a.example", "b.example"]); // www.는 같은 사이트
    expect(result.urls).toHaveLength(2);
  });

  it("[REQ-028] 같은 사이트의 여러 페이지는 1곳으로 센다", () => {
    const result = crossCheck("3.5L", [ev("https://a.example/1", "3.5L"), ev("https://a.example/2", "3.5L")]);
    expect(result).toMatchObject({ passed: false, sites: ["a.example"] });
  });

  it("[REQ-028] 발췌에 없는 값(모델 기억에서 꺼낸 값)은 통과하지 못한다", () => {
    expect(crossCheck("5L", [ev("https://a.example/1", "용량 3.5L"), ev("https://b.example/1", "용량 3.5L")]).passed).toBe(false);
  });

  it("[REQ-028] 한 곳에서만 확인된 값은 통과하지 못한다", () => {
    expect(crossCheck("3.5L", [ev("https://a.example/1", "3.5L"), ev("https://b.example/1", "다른 내용")]).passed).toBe(false);
  });

  it("[REQ-029] 따옴표·공백·말줄임 차이는 무시하고 글자는 그대로 맞아야 한다", () => {
    const quote = "오늘 하루도 충분히 애썼어요";
    expect(crossCheck(quote, [ev("https://a.example/1", "“오늘 하루도 충분히  애썼어요…”"), ev("https://b.example/1", `그는 ${quote}라고 했다`)]).passed).toBe(true);
    expect(crossCheck(quote, [ev("https://a.example/1", "오늘 하루도 충분히 애썼어"), ev("https://b.example/1", quote)]).passed).toBe(false);
  });

  it("[REQ-028] http(s)가 아닌 URL·빈 후보는 근거로 세지 않는다", () => {
    expect(crossCheck("3.5L", [ev("javascript:alert(1)", "3.5L"), ev("not a url", "3.5L")]).passed).toBe(false);
    expect(crossCheck("", [ev("https://a.example/1", "x"), ev("https://b.example/1", "x")]).passed).toBe(false);
  });

  it("[REQ-028] '리터'와 'L'은 같은 표기로 본다", () => {
    expect(normalizeForCheck("3.5 리터")).toBe(normalizeForCheck("3.5L"));
  });
});

describe("crossCheck — 숫자 경계", () => {
  const ev = (url: string, excerpt: string) => ({ url, excerpt });
  it("[REQ-028] '5L'은 '3.5L'·'15L'의 일부로 통과하지 못한다", () => {
    expect(crossCheck("5L", [ev("https://a.example/1", "용량 3.5L"), ev("https://b.example/1", "용량 15L")]).passed).toBe(false);
    expect(crossCheck("5L", [ev("https://a.example/1", "용량 5L"), ev("https://b.example/1", "5 리터 모델")]).passed).toBe(true);
  });
});
