import type { Category, CoveredProduct, Product } from "@contract/domain.js";
import { CATEGORY_ROTATION, MAX_PENDING_DRAFTS } from "@contract/domain.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * REQ-001 번갈아: **자동 소스가 있는 카테고리 안에서만** 순환한다.
 * 소스가 없는 카테고리 차례에 갇히면(마지막 생성이 그대로라 매일 같은 차례) 다른 카테고리가 영영 안 나온다 — REQ-005가 인정한 "도서만 자동" 상태.
 */
export function nextCategory(last: Category | null, available: readonly Category[]): Category | null {
  const usable = CATEGORY_ROTATION.filter((category) => available.includes(category));
  const first = usable[0];
  if (first === undefined) return null;
  if (last === null) return first;
  const index = usable.indexOf(last);
  if (index === -1) return first;
  return usable[(index + 1) % usable.length] ?? first;
}

/** REQ-003: 최근 `days`일 안에 다룬 상품은 제외한다. 정확히 `days`일 전은 다시 후보가 된다. */
export function filterRecentlyCovered(
  products: readonly Product[],
  covered: readonly CoveredProduct[],
  now: Date,
  days: number,
): Product[] {
  const cutoff = now.getTime() - days * DAY_MS;
  const recent = new Set(
    covered
      .filter((entry) => new Date(entry.coveredAt).getTime() > cutoff)
      .map((entry) => `${entry.source}:${entry.externalId}`),
  );
  return products.filter((product) => !recent.has(`${product.source}:${product.externalId}`));
}

/** REQ-004: 승인 대기 초안이 상한 이상이면 기본 모드 생성을 멈춘다. */
export function isPendingCapReached(pendingCount: number): boolean {
  return pendingCount >= MAX_PENDING_DRAFTS;
}
