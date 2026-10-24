import type { Draft, DraftBody, Product } from "@contract/domain.js";

import { kstMonthDay } from "../schedule/time.js";

import { computeFacts, factLinesFor } from "../draft/facts.js";

import { appendDisclosures } from "./disclosure.js";

const ELLIPSIS = "…";

/** 본문을 찾는 키 → 상품. 본문은 externalId로만 상품을 가리킨다(구매 링크는 렌더러가 붙인다). */
export const titleOf = (products: readonly Product[], externalId: string): string =>
  products.find((product) => product.externalId === externalId)?.title ?? externalId;

/** 링크·대가성 문구를 뺀 읽는 본문. 카드 미리보기와 최종 본문이 공유한다(DRY). */
function renderBody(body: DraftBody, products: readonly Product[]): string[] {
  if (body.category === "appliance") {
    const table = [body.comparison.headers, ...body.comparison.rows].map((row) => row.join(" | "));
    const facts = computeFacts(products);
    const recommendations = body.recommendations.map((rec) =>
      [`• ${rec.forWhom} → ${titleOf(products, rec.productExternalId)}: ${rec.reason}`, ...factLinesFor(rec.factIds, facts).map((line) => `  (근거: ${line})`)].join("\n"),
    );
    return [
      body.title,
      ...(body.intro === undefined ? [] : [body.intro]),
      `결론: ${body.verdict}`,
      table.join("\n"),
      recommendations.join("\n"),
      ...(body.closing === undefined ? [] : [body.closing]),
    ];
  }
  // B3 한 권 리뷰(ADR-010). 구매 링크는 renderPostText가 이어 붙인다.
  return [
    body.title,
    ...(body.intro === undefined ? [] : [body.intro]),
    `줄거리\n${body.synopsis}`,
    `분위기\n${body.mood}`,
    `이런 사람에게\n${body.recommendedFor}`,
    `인상 깊은 대목\n${body.highlights}`,
    ...(body.closing === undefined ? [] : [body.closing]),
  ];
}

/** REQ-032·033: `#태그 #태그` 한 줄(없으면 null). 카드와 ④ 전달본이 같은 형식을 쓴다. */
export const formatTags = (body: DraftBody): string | null =>
  body.tags === undefined || body.tags.length === 0 ? null : body.tags.map((tag) => `#${tag}`).join(" ");

export const formatPrice = (product: Product): string | null => {
  if (product.priceKrw === null) return null;
  const asOf = product.priceAsOf === null ? "" : ` (${kstMonthDay(new Date(product.priceAsOf))} 기준)`;
  return `약 ${product.priceKrw.toLocaleString("en-US")}원${asOf}`;
};

function renderLinks(products: readonly Product[]): string {
  const lines = products.map((product) => {
    const price = formatPrice(product);
    return [`- ${product.title}${price === null ? "" : ` — ${price}`}`, `  ${product.url}`].join("\n");
  });
  return ["구매 링크", ...lines].join("\n");
}

const hasExperience = (body: DraftBody): body is DraftBody & { experienceLine: string } =>
  (body.experienceLine ?? "").trim().length > 0;

/**
 * 발행용 최종 본문(플랫폼 중립 텍스트). 구매 링크·가격 기준일(REQ-011)·대가성 문구(REQ-010)를 여기서 붙인다.
 * 경험 한 줄은 사용자가 준 것이 있을 때만 문단으로 들어간다(REQ-011).
 */
export function renderPostText(draft: Draft): string {
  if (draft.body === null) throw new Error(`draft #${draft.id} has no body to render`);
  const sections = [...renderBody(draft.body, draft.products), renderLinks(draft.products)];
  if (hasExperience(draft.body)) sections.push(`내 경험\n${draft.body.experienceLine}`);
  const tags = formatTags(draft.body);
  if (tags !== null) sections.push(tags);
  return appendDisclosures(sections.join("\n\n"), draft.products);
}

/** REQ-007: 카드용 미리보기. 링크·대가성 문구는 넣지 않고, 한도를 넘으면 잘라 표시한다. */
export function renderPreview(draft: Draft, maxChars: number): string {
  if (draft.body === null) throw new Error(`draft #${draft.id} has no body to render`);
  const text = renderBody(draft.body, draft.products).join("\n\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}
