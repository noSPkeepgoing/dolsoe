import type { Category, Product } from "@contract/domain.js";

import { crossCheck, type Evidence } from "./cross-check.js";

/** 웹검색으로 찾은 스펙 후보 한 줄과 그 근거가 된 인용들. 판정(2곳 확인)은 코드가 한다(ADR-013). */
export interface SpecEvidence {
  candidates: { key: string; value: string }[];
  evidence: Evidence[];
}

/** 스펙 수집 경계. 실제 구현은 llm/spec-collector.ts(Anthropic 웹검색), 테스트는 가짜. 쿠팡 페이지는 읽지 않는다(ADR-008). */
export interface SpecCollector {
  collect(product: Product, keys: readonly string[]): Promise<SpecEvidence>;
}

/** 판단에 쓰는 스펙 항목. 지금은 용량만 근거 팩트로 이어진다(facts.ts). */
export const WEB_SPEC_KEYS = ["용량"] as const;

/** 후보 중 서로 다른 사이트 2곳 이상에 글자 그대로 있는 것만 스펙으로 인정한다. 같은 키 후보가 여럿이면 먼저 통과한 값을 쓴다. */
export function confirmSpecs(found: SpecEvidence): { specs: Record<string, string>; urls: string[] } {
  const specs: Record<string, string> = {};
  const urls: string[] = [];
  for (const candidate of found.candidates) {
    if (specs[candidate.key] !== undefined) continue;
    const result = crossCheck(candidate.value, found.evidence);
    if (!result.passed) continue;
    specs[candidate.key] = candidate.value;
    urls.push(...result.urls);
  }
  return { specs, urls: [...new Set(urls)] };
}

export interface GatheredSpecs {
  /** 웹 확인 값이 빈 칸에 채워진 상품들(사용자 값이 우선, 입력 순서 유지) */
  products: Product[];
  /** 웹 확인에 쓴 출처 URL(초안 DB에만) */
  specSources?: string[];
  /** 판단에 쓸 수 있는 스펙 값의 출처 개수: 사용자 입력 / 웹 확인 */
  specOrigin: { user: number; web: number };
}

const countKeys = (products: readonly Product[], keys: readonly string[]): number =>
  products.reduce((sum, product) => sum + keys.filter((key) => product.specs[key] !== undefined).length, 0);

/**
 * REQ-028: 스펙 출처 우선순위 ① 사용자가 링크 줄에 적은 값 ② 웹 2곳 이상 확인 ③ 나머지는 비워 둠(판단 안 함).
 * 가전만, 사용자 값이 이미 있는 항목은 검색하지 않는다(비용). 수집이 실패해도 초안은 계속 만든다 — 그 항목만 판단에서 빠진다.
 */
export async function gatherSpecs(
  category: Category,
  products: readonly Product[],
  collector: SpecCollector | undefined,
  onFailure?: (reason: string) => void,
): Promise<GatheredSpecs> {
  const user = countKeys(products, WEB_SPEC_KEYS);
  if (category !== "appliance" || collector === undefined) return { products: [...products], specOrigin: { user, web: 0 } };

  const sources: string[] = [];
  let web = 0;
  const merged: Product[] = [];
  for (const product of products) {
    const missing = WEB_SPEC_KEYS.filter((key) => product.specs[key] === undefined);
    if (missing.length === 0) {
      merged.push(product);
      continue;
    }
    try {
      const confirmed = confirmSpecs(await collector.collect(product, missing));
      const fill = Object.fromEntries(Object.entries(confirmed.specs).filter(([key]) => missing.includes(key as (typeof WEB_SPEC_KEYS)[number])));
      web += Object.keys(fill).length;
      if (Object.keys(fill).length > 0) sources.push(...confirmed.urls);
      merged.push({ ...product, specs: { ...product.specs, ...fill } });
    } catch (error) {
      onFailure?.(`스펙 수집 실패(${product.title}): ${error instanceof Error ? error.message : String(error)}`);
      merged.push(product);
    }
  }
  return { products: merged, ...(sources.length > 0 ? { specSources: [...new Set(sources)] } : {}), specOrigin: { user, web } };
}
