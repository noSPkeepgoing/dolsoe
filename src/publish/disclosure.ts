import type { Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

/** REQ-010: 이 상품들이 요구하는 대가성 문구(제휴 프로그램별 1개, 등장 순서대로). LLM이 아니라 여기서 정한다(CONVENTIONS §5). */
export function requiredDisclosures(products: readonly Product[]): string[] {
  const affiliates = [...new Set(products.map((product) => product.affiliate))];
  return affiliates.map((affiliate) => DISCLOSURE_TEXTS[affiliate]);
}

export function appendDisclosures(text: string, products: readonly Product[]): string {
  return `${text.trimEnd()}\n\n${requiredDisclosures(products).join("\n")}`;
}

/** 발행 직전 공통 게이트: 본문에 없는 대가성 문구 목록. 비어 있어야 발행할 수 있다. */
export function missingDisclosures(text: string, products: readonly Product[]): string[] {
  return requiredDisclosures(products).filter((disclosure) => !text.includes(disclosure));
}
