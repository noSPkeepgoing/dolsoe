import type { DraftBody, Product, QualityReport } from "@contract/domain.js";
import { BANNED_PHRASES } from "@contract/domain.js";

/** 검사 대상은 봇이 만든 문장뿐이다. 사용자가 준 경험 문장(`experienceLine`)과 분류용 `category`는 제외(REQ-011). */
const EXCLUDED_KEYS = new Set(["experienceLine", "category"]);

function collectBotText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectBotText(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (!EXCLUDED_KEYS.has(key)) collectBotText(nested, out);
    }
  }
}

/** REQ-015: 금지 표현(중복 없이)과 경험 한 줄 유무. */
export function checkQuality(body: DraftBody): QualityReport {
  const texts: string[] = [];
  collectBotText(body, texts);
  const joined = texts.join("\n");
  return {
    bannedPhrasesFound: BANNED_PHRASES.filter((phrase) => joined.includes(phrase)),
    hasExperienceLine: (body.experienceLine ?? "").trim().length > 0,
  };
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

  const seen = new Set<string>();
  for (const item of body.items) {
    if (!known.has(item.productExternalId)) {
      problems.push(`책 소개가 존재하지 않는 상품 ID ${item.productExternalId}를 가리킵니다`);
    } else if (seen.has(item.productExternalId)) {
      problems.push(`같은 책(${item.productExternalId})을 두 번 소개합니다`);
    }
    seen.add(item.productExternalId);
  }
  for (const product of products) {
    if (!seen.has(product.externalId)) problems.push(`상품 ${product.externalId}가 소개에서 빠졌습니다`);
  }
  return problems;
}
