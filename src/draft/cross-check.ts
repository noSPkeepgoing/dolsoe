import { CROSS_CHECK_MIN_SITES } from "@contract/domain.js";

/** 웹검색 인용 하나: 어느 페이지(url)의 어떤 원문 발췌(excerpt)인가. */
export interface Evidence {
  url: string;
  excerpt: string;
}

/** 비교 전 정규화: 공백·따옴표·말줄임을 지우고 소문자로. "3.5 L"과 "3.5l", “문장…”과 "문장"이 같게 본다. */
export function normalizeForCheck(text: string): string {
  return text
    .replace(/[\s"'“”‘’「」『』…]|\.{3}/g, "")
    .replace(/리터|ℓ/g, "l")
    .toLowerCase();
}

/**
 * `haystack`에 `needle`이 들어 있는가. 숫자로 시작·끝나는 후보("5L")가 더 긴 숫자의 일부("3.5L", "15L")에 걸려 통과하지 않도록
 * 그 가장자리에 숫자·소수점이 바로 붙어 있으면 다른 값으로 본다.
 */
function containsToken(haystack: string, needle: string): boolean {
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
    const before = haystack[from - 1];
    const after = haystack[from + needle.length];
    const startsNumeric = /\d/.test(needle[0]!);
    const endsNumeric = /\d/.test(needle.at(-1)!);
    if (startsNumeric && before !== undefined && /[\d.]/.test(before)) continue;
    if (endsNumeric && after !== undefined && /\d/.test(after)) continue;
    return true;
  }
  return false;
}

/** 사이트 구분 키: 호스트에서 www.만 뗀다(서브도메인이 다르면 다른 사이트로 본다). 깨진 URL은 null. */
function siteOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface CrossCheckResult {
  passed: boolean;
  /** 후보가 글자 그대로 들어 있던 서로 다른 사이트 */
  sites: string[];
  /** 그 사이트들의 URL(DB에 보관할 출처, 사이트당 하나) */
  urls: string[];
}

/**
 * REQ-028·029 / ADR-013: 후보가 서로 다른 사이트 `CROSS_CHECK_MIN_SITES`곳 이상의 원문 발췌에 **글자 그대로** 들어 있을 때만 통과한다.
 * 판정은 모델이 아니라 이 함수가 한다 — 모델이 기억에서 꺼낸 값은 발췌에 없으니 통과하지 못한다. 필사 문구와 가전 스펙이 같이 쓴다.
 */
export function crossCheck(candidate: string, evidence: readonly Evidence[]): CrossCheckResult {
  const needle = normalizeForCheck(candidate);
  const bySite = new Map<string, string>();
  if (needle.length > 0) {
    for (const item of evidence) {
      const site = siteOf(item.url);
      if (site !== null && !bySite.has(site) && containsToken(normalizeForCheck(item.excerpt), needle)) bySite.set(site, item.url);
    }
  }
  return { passed: bySite.size >= CROSS_CHECK_MIN_SITES, sites: [...bySite.keys()], urls: [...bySite.values()] };
}
