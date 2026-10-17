import type { Category, Product } from "@contract/domain.js";

/** REQ-016: 후기 수집 결과. 노트는 의역된 요약이고, 출처 URL은 초안 DB에만 보관한다(발행 본문 금지). */
export interface ReviewEvidence {
  notes: string;
  sources: string[];
  /** 인용된 후기 원문 조각. 본문이 후기 문장을 그대로 옮겼는지 대조하는 데만 쓰고 모델에는 보내지 않는다. */
  excerpts?: string[];
}

/** 후기 수집 경계. 실제 구현은 llm/review-collector.ts(Anthropic 웹검색), 테스트는 가짜. */
export interface ReviewCollector {
  collect(product: Product): Promise<ReviewEvidence>;
}

const NO_EVIDENCE: ReviewEvidence = { notes: "", sources: [] };

/**
 * REQ-016 / ADR-010 결정 6: 수집이 실패하거나 수집기가 없으면 "후기 근거 없음"으로 계속한다 — 후기 때문에 초안이 막히지 않는다.
 * 실패 이유는 호출 쪽이 알림·로그로 남기도록 `onFailure`로 넘긴다.
 */
export async function collectReviewsSafely(
  collector: ReviewCollector | undefined,
  product: Product,
  onFailure?: (reason: string) => void,
): Promise<ReviewEvidence> {
  if (collector === undefined) return NO_EVIDENCE;
  try {
    return await collector.collect(product);
  } catch (error) {
    onFailure?.(`후기 수집 실패: ${error instanceof Error ? error.message : String(error)}`);
    return NO_EVIDENCE;
  }
}

/**
 * REQ-016: 초안 한 편의 후기 근거. 책만 수집하고(가전은 `{}`), 책이면 근거가 없어도 `reviewSources: []`를 남겨
 * 카드가 "후기 근거 없음"을 보여줄 수 있게 한다. 일일·링크 모드가 같은 규칙을 쓰도록 한 곳에 둔다(DRY).
 */
export async function gatherReviews(
  category: Category,
  products: readonly Product[],
  collector: ReviewCollector | undefined,
  onFailure?: (reason: string) => void,
): Promise<{ reviewNotes?: string; reviewSources?: string[]; reviewExcerpts?: string[] }> {
  const book = products[0];
  if (category !== "book" || book === undefined) return {};
  const evidence = await collectReviewsSafely(collector, book, onFailure);
  // 노트가 비면 근거가 없는 것이다 — 출처만 남아 카드에 "후기 N건 참고"가 뜨지 않게 함께 비운다.
  if (evidence.notes.trim().length === 0) return { reviewSources: [] };
  return {
    reviewNotes: evidence.notes,
    reviewSources: evidence.sources,
    ...(evidence.excerpts !== undefined && evidence.excerpts.length > 0 ? { reviewExcerpts: evidence.excerpts } : {}),
  };
}
