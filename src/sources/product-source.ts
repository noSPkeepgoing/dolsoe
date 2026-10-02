import type { Category, Product } from "@contract/domain.js";

/** 상품 소스 경계(ADR-008·009). 기본 모드는 이 인터페이스만 안다. */
export interface ProductSource {
  /** 이 소스가 자동으로 후보를 줄 수 있는 카테고리 */
  readonly categories: readonly Category[];
  fetchCandidates(category: Category): Promise<Product[]>;
}
