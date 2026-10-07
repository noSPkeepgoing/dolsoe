import { z } from "zod";

import type { BookDetail, Category, Product } from "@contract/domain.js";
import { BOOK_CANDIDATE_CATEGORY_IDS, BOOK_DETAIL_MAX_CHARS } from "@contract/domain.js";

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
  // 소개문·목차(REQ-002). 목록 응답에도 들어 있다. 모양이 달라져도 후보를 버리지 않도록 관대하게 읽는다.
  contentDetail: z
    .object({ bookIntroduction: z.string().nullish(), tableOfContents: z.string().nullish() })
    .nullish()
    .catch(undefined),
});
type Item = z.infer<typeof ItemSchema>;

const EnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(ItemSchema) }),
});

/** 링크 모드에서 사용자가 보낸 상품을 쓸 수 없을 때(없는 상품·수익 링크 없음). 사용자에게 그대로 보여줄 수 있는 문장이다. */
export class Yes24LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Yes24LinkError";
  }
}

const ErrorEnvelopeSchema = z.object({ errorCode: z.string().optional(), message: z.string().optional() });

const present = (value: string | number | null | undefined): string | null => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text.length > 0 ? text : null;
};

const HTML_ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** 소개문·목차용: HTML 태그·엔티티·여분 공백을 걷고 BOOK_DETAIL_MAX_CHARS로 자른다. 비면 null. */
function cleanDetailText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0 ? null : text.slice(0, BOOK_DETAIL_MAX_CHARS).trimEnd();
}

function toBookDetail(item: Item): BookDetail | undefined {
  const introduction = cleanDetailText(item.contentDetail?.bookIntroduction);
  const tableOfContents = cleanDetailText(item.contentDetail?.tableOfContents);
  return introduction === null && tableOfContents === null ? undefined : { introduction, tableOfContents };
}

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
  const bookDetail = toBookDetail(item);
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
    ...(bookDetail === undefined ? {} : { bookDetail }),
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

/** 목록들을 순위대로 한 권씩 번갈아 합치고, 여러 목록에 걸친 같은 책은 먼저 나온 한 번만 남긴다. */
function interleaveUnique(lists: readonly Product[][]): Product[] {
  const seen = new Set<string>();
  const merged: Product[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const product = list[rank];
      if (product !== undefined && !seen.has(product.externalId)) {
        seen.add(product.externalId);
        merged.push(product);
      }
    }
  }
  return merged;
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

  /** 호출하고, 200이 아니면 오류 코드를 담은 응답 정보를 돌려준다. 호출 쪽이 어떤 코드를 오류로 볼지 정한다. */
  private async call(pathAndQuery: string): Promise<{ ok: true; json: unknown } | { ok: false; error: Yes24ApiError }> {
    const response = await this.fetchFn(`${BASE_URL}${pathAndQuery}`, { headers: { "X-Api-Key": this.apiKey } });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, json };

    const parsed = ErrorEnvelopeSchema.safeParse(json);
    const errorCode = (parsed.success ? parsed.data.errorCode : undefined) ?? `HTTP_${response.status}`;
    const message = (parsed.success ? parsed.data.message : undefined) ?? response.statusText;
    return { ok: false, error: new Yes24ApiError(`YES24 API ${errorCode}: ${message}`, errorCode, response.status) };
  }

  /**
   * REQ-001·005: 소설·에세이 베스트셀러(ADR-010)를 카테고리별로 받아 순위대로 번갈아 섞는다.
   * 실서버는 categoryId가 없으면 400 PARAM_001로 거절한다(2026-10-07 실호출로 확인). 한 카테고리의 "결과 없음"은 건너뛴다.
   */
  async fetchCandidates(category: Category): Promise<Product[]> {
    if (category !== "book") throw new Error(`Yes24Source does not support category: ${category}`);

    const lists: Product[][] = [];
    for (const categoryId of BOOK_CANDIDATE_CATEGORY_IDS) {
      const result = await this.call(`/v1/category/bestseller?categoryId=${categoryId}&pageSize=${CANDIDATE_PAGE_SIZE}`);
      if (!result.ok) {
        if (result.error.status === 404 && result.error.errorCode === "BEST_001") continue; // 결과 없음은 오류가 아니다(REQ-005는 호출 쪽이 처리)
        throw result.error;
      }
      lists.push(parseYes24Items(result.json, this.now()));
    }
    return interleaveUnique(lists);
  }

  /** REQ-006 링크 모드: 상품번호 하나의 상세. 수익 링크(addOnLink)가 없는 상품은 쓸 수 없다(ADR-009). */
  async fetchItem(itemId: string): Promise<Product> {
    const result = await this.call(`/v1/goods/itemDetail?searchType=ItemId&query=${encodeURIComponent(itemId)}`);
    if (!result.ok) {
      if (result.error.status === 404 && ["GOODS_001", "GOODS_002"].includes(result.error.errorCode)) {
        throw new Yes24LinkError(`YES24에서 상품 ${itemId}를 찾지 못했어요.`);
      }
      throw result.error;
    }
    const [product] = parseYes24Items(result.json, this.now());
    if (product === undefined) {
      throw new Yes24LinkError(`상품 ${itemId}는 판매 중이 아니거나 수익 링크(애드온)가 없어 쓸 수 없어요.`);
    }
    return product;
  }
}
