import type { Category, Product, Quote } from "@contract/domain.js";
import { QUOTE_MAX_CHARS } from "@contract/domain.js";

import { crossCheck, type Evidence } from "./cross-check.js";

/** 웹검색으로 찾은 필사 문구 후보와 그 근거 인용들. 판정(2곳에 글자 그대로)은 코드가 한다(ADR-013). */
export interface QuoteEvidence {
  candidates: string[];
  evidence: Evidence[];
}

/** 필사 문구 수집 경계. 실제 구현은 llm/quote-collector.ts(Anthropic 웹검색), 테스트는 가짜. YES24 페이지는 읽지 않는다(ADR-010). */
export interface QuoteCollector {
  collect(product: Product): Promise<QuoteEvidence>;
}

const SENTENCE_SPLIT = /(?<=[.!?。…])\s+/;
const URL_LIKE = /https?:\/\/|www\./i;

/** 1~2문장이고 `QUOTE_MAX_CHARS`자 이하이며 URL이 아닌가. 따옴표 장식은 호출 쪽에서 이미 뗐다. */
export function fitsQuote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > QUOTE_MAX_CHARS || URL_LIKE.test(trimmed)) return false;
  const sentences = trimmed.split(SENTENCE_SPLIT).filter((sentence) => sentence.length > 0);
  return sentences.length >= 1 && sentences.length <= 2;
}

const bookMark = (product: Product): string => {
  const author = product.specs["저자"];
  return author === undefined ? `『${product.title}』` : `『${product.title}』, ${author}`;
};

/** "문구: …" / "필사: …" 줄 → 사용자가 보낸 필사 문구(앞뒤 공백·감싼 따옴표만 다듬는다). 없으면 null. `없음`은 별도 처리(parseQuoteDirective). */
const USER_QUOTE_LINE = /^\s*(?:문구|필사)\s*[:：]\s*(.*)$/m;
const WRAPPING_QUOTES = /^["“”'‘’「『]+|["“”'‘’」』]+$/g;

export type QuoteDirective = { kind: "none" } | { kind: "clear" } | { kind: "set"; text: string };

/** 메시지·수정 지시에서 문구 줄을 결정적으로(LLM 없이) 읽는다. `문구: 없음`은 지우기 명령이다. */
export function parseQuoteDirective(text: string): QuoteDirective {
  const matched = USER_QUOTE_LINE.exec(text)?.[1]?.trim();
  if (matched === undefined || matched.length === 0) return { kind: "none" };
  if (matched === "없음") return { kind: "clear" };
  const cleaned = matched.replace(WRAPPING_QUOTES, "").trim();
  return cleaned.length === 0 ? { kind: "none" } : { kind: "set", text: cleaned };
}

/** 문구 줄만 뺀 나머지(메모에서 필사 문구가 일반 메모로 섞이지 않게). 남는 것이 없으면 null. */
export function stripQuoteLine(text: string): string | null {
  const rest = text
    .split(/\r?\n/)
    .filter((line) => !USER_QUOTE_LINE.test(line))
    .join("\n")
    .trim();
  return rest.length === 0 ? null : rest;
}

/** ① 사용자가 보낸 문구. 길이 한도는 적용하지 않는다(내가 고른 문장이다). 출처는 이 책으로 표기한다. */
export function userQuote(text: string, product: Product): Quote {
  return { text, attribution: `— ${bookMark(product)}`, origin: "user" };
}

/** ② 서로 다른 사이트 2곳 이상의 원문 발췌에 글자 그대로 있는 후보 중 길이 조건을 맞는 첫 번째. 출처 URL은 DB용으로 함께 돌려준다. */
export function pickWebQuote(found: QuoteEvidence, product: Product): { quote: Quote; urls: string[] } | null {
  for (const candidate of found.candidates) {
    if (!fitsQuote(candidate)) continue;
    const checked = crossCheck(candidate, found.evidence);
    if (checked.passed) return { quote: { text: candidate.trim(), attribution: `— ${bookMark(product)}`, origin: "web" }, urls: checked.urls };
  }
  return null;
}

/** 소개문 속 추천사: “문장” — 이름(직함). 따옴표 안의 한두 문장과 그 뒤 대시 이름을 함께 잡는다. */
const ENDORSEMENT = /[“"「『]([^”"」』\n]{8,200})[”"」』]\s*[-—–―]\s*([^\n()]{2,20}(?:\([^)\n]{1,20}\))?)/g;

/**
 * ③ 소개문에서 문장을 가져온다. 추천사(따옴표 + 대시 이름)가 있으면 "— 이름"으로, 그 밖의 소개문 문장은 "— 『제목』 소개글 중"으로
 * 출처를 정직하게 밝힌다. 소개문 글자 그대로만 쓴다(문장을 합치거나 고치지 않는다).
 */
export function pickIntroQuote(product: Product): Quote | null {
  const intro = product.bookDetail?.introduction;
  if (intro == null || intro.trim().length === 0) return null;

  for (const match of intro.matchAll(ENDORSEMENT)) {
    const text = match[1]!.trim();
    if (fitsQuote(text)) return { text, attribution: `— ${match[2]!.trim()}`, origin: "intro" };
  }
  const sentences = intro
    .split(/\r?\n+|(?<=[.!?。])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && fitsQuote(sentence) && !/[?？]$/.test(sentence));
  const first = sentences[0];
  return first === undefined ? null : { text: first, attribution: `— 『${product.title}』 소개글 중`, origin: "intro" };
}

export interface GatheredQuote {
  quote: Quote | null;
  /** 웹 확인에 쓴 출처 URL(초안 DB에만) */
  quoteSources?: string[];
}

/**
 * REQ-029: 필사 문구 우선순위 ① 사용자 문구 ② 웹 2곳 교차 확인 ③ 소개문 ④ 없음(코너 생략).
 * 책만 고르고, 사용자 문구가 있으면 검색하지 않는다(비용). 수집이 실패해도 초안은 소개문·없음으로 계속 만든다.
 */
export async function gatherQuote(
  category: Category,
  products: readonly Product[],
  user: string | null,
  collector: QuoteCollector | undefined,
  onFailure?: (reason: string) => void,
): Promise<GatheredQuote> {
  const book = products[0];
  if (category !== "book" || book === undefined) return { quote: null };
  if (user !== null) return { quote: userQuote(user, book) };

  if (collector !== undefined) {
    try {
      const web = pickWebQuote(await collector.collect(book), book);
      if (web !== null) return { quote: web.quote, quoteSources: web.urls };
    } catch (error) {
      onFailure?.(`필사 문구 수집 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { quote: pickIntroQuote(book) };
}
