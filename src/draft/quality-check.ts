import type { DraftBody, Product, QualityReport } from "@contract/domain.js";
import {
  BANNED_PHRASES,
  CHOSEONG_PATTERN,
  EXCLAMATIONS_MAX,
  EXPERIENCE_CLAIM_PATTERNS,
  SENTENCES_PER_PARAGRAPH_MAX,
  STYLE_VIOLATION_PATTERNS,
  VERBATIM_MIN_CHARS,
} from "@contract/domain.js";

/** 검사 대상은 봇이 만든 문장뿐이다. 사용자가 준 경험 문장(`experienceLine`)과 분류용 `category`는 제외(REQ-011). */
const EXCLUDED_KEYS = new Set(["experienceLine", "category"]);

/** `quote.text`는 출처에서 글자 그대로 검증된 문장(`trustedQuote`)과 같을 때만 검사에서 뺀다(ADR-012). */
interface CollectOptions {
  trustedQuote?: string | null;
}

function collectBotText(value: unknown, out: string[], options: CollectOptions = {}, key?: string, parent?: unknown): void {
  if (typeof value === "string") {
    const isTrustedQuote =
      key === "text" && options.trustedQuote != null && value === options.trustedQuote && parent !== null && typeof parent === "object" && "attribution" in parent;
    if (!isTrustedQuote) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectBotText(item, out, options);
  } else if (value !== null && typeof value === "object") {
    for (const [childKey, nested] of Object.entries(value)) {
      if (!EXCLUDED_KEYS.has(childKey)) collectBotText(nested, out, options, childKey, value);
    }
  }
}

const SENTENCE_SPLIT = /(?<=[.!?。])\s+/;

/** REQ-027·030: 체험 어미·L4 신호 패턴, 느낌표·문단 문장 수 한도, 초성 표현. 걸린 부분·사유를 사람이 읽을 문자열로 돌려준다. */
function findStyleIssues(texts: readonly string[]): string[] {
  const issues: string[] = [];
  const joined = texts.join("\n");
  for (const pattern of STYLE_VIOLATION_PATTERNS) {
    const match = pattern.exec(joined);
    if (match !== null) issues.push(match[0]);
  }
  const exclamations = (joined.match(/!/g) ?? []).length;
  if (exclamations > EXCLAMATIONS_MAX) issues.push(`느낌표 ${exclamations}개(최대 ${EXCLAMATIONS_MAX})`);
  const longest = Math.max(
    0,
    ...texts.flatMap((text) => text.split("\n").map((paragraph) => paragraph.trim().split(SENTENCE_SPLIT).filter((sentence) => sentence.length > 0).length)),
  );
  if (longest > SENTENCES_PER_PARAGRAPH_MAX) issues.push(`문단 문장 ${longest}개(최대 ${SENTENCES_PER_PARAGRAPH_MAX})`);
  const choseong = CHOSEONG_PATTERN.exec(joined);
  if (choseong !== null) issues.push(`초성 표현 ${choseong[0]}`);
  return issues;
}

/** REQ-015·030: 금지 표현(중복 없이)·문체 위반·경험 한 줄 유무. */
export function checkQuality(body: DraftBody, options: CollectOptions = {}): QualityReport {
  const texts: string[] = [];
  collectBotText(body, texts, options);
  const joined = texts.join("\n");
  return {
    bannedPhrasesFound: BANNED_PHRASES.filter((phrase) => joined.includes(phrase)),
    hasExperienceLine: (body.experienceLine ?? "").trim().length > 0,
    styleIssues: findStyleIssues(texts),
  };
}

/** REQ-011: 봇이 지어낸 후기·경험 표현(걸린 부분 문자열). 사용자가 준 경험 문장은 제외한다. */
export function findExperienceClaims(body: DraftBody): string[] {
  const texts: string[] = [];
  collectBotText(body, texts);
  const joined = texts.join("\n");
  return EXPERIENCE_CLAIM_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(joined);
    return match === null ? [] : [match[0]];
  });
}

/**
 * REQ-002: 본문이 실제 상품 목록과 골격에 맞는지 기계로 확인한다. 모델이 없는 상품 ID를 만들거나 표가 어긋나는 것을 잡는다.
 * 구매 링크·대가성 문구는 본문이 아니라 렌더러가 products로 붙이므로 여기서는 보지 않는다(CONVENTIONS §5).
 */
export function validateAgainstProducts(body: DraftBody, products: readonly Product[]): string[] {
  const problems: string[] = [];
  const known = new Set(products.map((product) => product.externalId));

  if (body.category === "appliance") {
    if (body.comparison.rows.length !== products.length) {
      problems.push(`비교표 행 수(${body.comparison.rows.length})가 상품 수(${products.length})와 다릅니다`);
    }
    const columns = body.comparison.headers.length;
    body.comparison.rows.forEach((row, index) => {
      if (row.length !== columns) problems.push(`비교표 ${index + 1}번째 행의 열 수(${row.length})가 머리글(${columns})과 다릅니다`);
    });
    for (const rec of body.recommendations) {
      if (!known.has(rec.productExternalId)) problems.push(`추천이 존재하지 않는 상품 ID ${rec.productExternalId}를 가리킵니다`);
    }
    return problems;
  }

  // 책은 한 권짜리라 본문이 상품 ID를 가리키지 않는다(B3, ADR-010). 상품 수는 소스·작업이 보장한다.
  return problems;
}

const QUOTE_CHARS = /["“”]/;
const URL_PATTERN = /https?:\/\/|www\./i;
const withoutSpaces = (text: string): string => text.replace(/\s+/g, "");

/** `source` 안에 `text`와 `minChars` 이상 그대로 이어지는 구간이 있는가(공백 무시). */
function sharesVerbatimRun(text: string, source: string, minChars: number): boolean {
  if (text.length < minChars || source.length < minChars) return false;
  for (let start = 0; start + minChars <= text.length; start++) {
    if (source.includes(text.slice(start, start + minChars))) return true;
  }
  return false;
}

/**
 * REQ-016: 책 초안이 후기·소개문을 옮겨 적지 않았는지 기계로 확인한다(ADR-010).
 * 직접 인용(큰따옴표)·URL은 항상 금지, 소개문·목차와 `VERBATIM_MIN_CHARS`자 이상 그대로 겹치면 복사로 본다.
 * 책 제목·저자처럼 원래 겹치는 고유명은 비교 전에 뺀다. 사용자가 준 경험 문장은 검사 제외(REQ-011).
 * 후기 원문은 웹검색 인용의 `cited_text` 조각(reviewExcerpts)으로만 대조한다 — 인용되지 않은 후기 문장은 기계로 볼 수 없어 프롬프트 규칙과 사람의 승인이 맡는다.
 */
export function findCopyProblems(body: DraftBody, products: readonly Product[], reviewExcerpts: readonly string[] = []): string[] {
  if (body.category !== "book") return [];
  const texts: string[] = [];
  collectBotText(body, texts);
  const joined = texts.join("\n");

  const problems: string[] = [];
  if (QUOTE_CHARS.test(joined)) problems.push("큰따옴표 직접 인용이 있습니다. 후기는 인용 없이 의역만 하세요");
  if (URL_PATTERN.test(joined)) problems.push("본문에 URL이 있습니다. 출처는 본문에 쓰지 않습니다");

  const names = products.flatMap((product) => [product.title, product.specs["저자"] ?? ""]).map(withoutSpaces).filter((name) => name.length > 0);
  const stripNames = (text: string): string => names.reduce((acc, name) => acc.split(name).join("\u0000"), withoutSpaces(text));
  const compared = stripNames(joined);

  for (const product of products) {
    const detail = product.bookDetail;
    if (detail === undefined) continue;
    const checks: [string, string | null][] = [
      ["소개문", detail.introduction],
      ["목차", detail.tableOfContents],
    ];
    for (const [label, source] of checks) {
      if (source !== null && sharesVerbatimRun(compared, stripNames(source), VERBATIM_MIN_CHARS)) {
        problems.push(`${label}를 ${VERBATIM_MIN_CHARS}자 이상 그대로 옮겼습니다. 줄거리·분위기는 자기 말로 바꿔 쓰세요`);
      }
    }
  }
  if (reviewExcerpts.some((excerpt) => sharesVerbatimRun(compared, stripNames(excerpt), VERBATIM_MIN_CHARS))) {
    problems.push(`후기 원문을 ${VERBATIM_MIN_CHARS}자 이상 그대로 옮겼습니다. 후기는 자기 말로 의역하세요`);
  }
  return problems;
}

const SENTENCE_BREAK = /(?<=[.!?。])\s+|\n+/;

/**
 * REQ-016: 후기 노트 안에서 후기 원문 조각과 `VERBATIM_MIN_CHARS`자 이상 그대로 겹치는 문장을 버린다(수집 모델이 후기를 베껴 쓴 부분).
 * 남은 문장은 줄바꿈으로 이어 돌려준다. 전부 겹치면 빈 문자열.
 */
export function dropCopiedSentences(text: string, references: readonly string[]): string {
  const refs = references.map(withoutSpaces).filter((ref) => ref.length > 0);
  return text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !refs.some((ref) => sharesVerbatimRun(withoutSpaces(sentence), ref, VERBATIM_MIN_CHARS)))
    .join("\n");
}
