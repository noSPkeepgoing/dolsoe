import { z } from "zod";

import type { Category, Product } from "@contract/domain.js";

import type { ProductSource } from "./product-source.js";

const BASE_URL = "https://apis.yes24.com";
/** 광고·품절·성인물·수익 링크 없음을 걸러내고도 한 편(5권)이 남도록 넉넉히 가져온다. */
const CANDIDATE_PAGE_SIZE = 30;

export class Yes24ApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Yes24ApiError";
  }
}

// 응답 계약: 공식 OpenAPI 명세·샘플(yes24-AX/yes24-openapi-samples)에서 확인한 필드. 핵심(itemId·title·salePrice)은 엄격, 나머지는 관대.
const ItemSchema = z.object({
  itemId: z.number().int(),
  title: z.string().min(1),
  salePrice: z.number().int().nonnegative(),
  itemStatus: z.string(),
  adultYn: z.string().nullish(),
  author: z.string().nullish(),
  publisher: z.string().nullish(),
  isbn13: z.string().nullish(),
  shopPrice: z.number().int().nonnegative().nullish(),
  publishDate: z.string().nullish(),
  addOnLink: z.string().nullish(),
});
type Item = z.infer<typeof ItemSchema>;

const EnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(ItemSchema) }),
});

const ErrorEnvelopeSchema = z.object({ errorCode: z.string().optional(), message: z.string().optional() });

const present = (value: string | number | null | undefined): string | null => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text.length > 0 ? text : null;
};

function toProduct(item: Item, addOnLink: string, now: Date): Product {
  const specs: Record<string, string> = {};
  const entries: [string, string | null][] = [
    ["저자", present(item.author)],
    ["출판사", present(item.publisher)],
    ["정가", present(item.shopPrice)],
    ["출간일", present(item.publishDate)],
    ["ISBN", present(item.isbn13)],
  ];
  for (const [key, value] of entries) if (value !== null) specs[key] = value;
  return {
    externalId: String(item.itemId),
    source: "yes24",
    category: "book",
    affiliate: "yes24",
    title: item.title,
    url: addOnLink, // 수익 연결 링크만 쓴다(`link`는 수익 미연결 — ADR-009)
    priceKrw: item.salePrice,
    priceAsOf: now.toISOString(),
    specs,
  };
}

/**
 * 응답 → 후보 Product. 성인물·판매중이 아닌 상품·수익 링크(addOnLink)가 없는 상품은 제외한다.
 * 모양이 계약과 다르면 조용히 넘기지 않고 예외로 드러낸다(CONVENTIONS §5).
 */
export function parseYes24Items(json: unknown, now: Date): Product[] {
  const { data } = EnvelopeSchema.parse(json);
  const products: Product[] = [];
  for (const item of data.items) {
    const addOnLink = present(item.addOnLink);
    if (item.adultYn === "Y" || item.itemStatus !== "판매중" || addOnLink === null) continue;
    products.push(toProduct(item, addOnLink, now));
  }
  return products;
}

export class Yes24Source implements ProductSource {
  readonly categories: readonly Category[] = ["book"];
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(options: { apiKey: string; fetchFn?: typeof fetch; now?: () => Date }) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetchCandidates(category: Category): Promise<Product[]> {
    if (category !== "book") throw new Error(`Yes24Source does not support category: ${category}`);

    const response = await this.fetchFn(`${BASE_URL}/v1/category/bestseller?pageSize=${CANDIDATE_PAGE_SIZE}`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = ErrorEnvelopeSchema.safeParse(json);
      const errorCode = (error.success ? error.data.errorCode : undefined) ?? `HTTP_${response.status}`;
      if (response.status === 404 && errorCode === "BEST_001") return []; // 결과 없음은 오류가 아니다(REQ-005는 호출 쪽이 처리)
      const message = (error.success ? error.data.message : undefined) ?? response.statusText;
      throw new Yes24ApiError(`YES24 API ${errorCode}: ${message}`, errorCode, response.status);
    }
    return parseYes24Items(json, this.now());
  }
}
