import type { Category, CoveredProduct, Draft, Product } from "@contract/domain.js";
import { DEDUP_DAYS, PRODUCTS_PER_DRAFT } from "@contract/domain.js";

import type { NewDraft } from "../db.js";
import { deliverCardSafely } from "../draft/deliver.js";
import { generateDraftBody, type BodyGenerator } from "../draft/generate.js";
import { gatherQuote, type QuoteCollector } from "../draft/quote.js";
import { gatherReviews, type ReviewCollector } from "../draft/review.js";
import { filterRecentlyCovered, isPendingCapReached, nextCategory } from "../draft/rules.js";
import { isBudgetExceeded } from "../llm/cost.js";
import type { ProductSource } from "../sources/product-source.js";

/** 일일 작업이 필요로 하는 저장소 경계. 실제 구현은 draft/store.ts(SQLite), 테스트는 가짜. */
export interface DraftStore {
  countPending(): number;
  getLastCategory(): Category | null;
  listCovered(): CoveredProduct[];
  getMonthCostKrw(): number;
  /** 초안 저장 + 다룬 상품 기록 + (기본 모드면) 마지막 카테고리 기록을 한 번에. */
  saveDraft(draft: NewDraft, covered: Product[]): Draft;
}

export type SkipReason = "pending_cap" | "budget" | "no_source" | "no_candidates" | "source_error" | "generation_error";
export type DailyDraftResult = { status: "created"; draft: Draft } | { status: "skipped"; reason: SkipReason };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 기본 모드 하루 1편(REQ-001): 상한(REQ-004)·비용 확인 → 카테고리 선택 → 후보 수집(REQ-005) →
 * 중복 제외(REQ-003) → 생성·검사(REQ-002·015) → 승인 대기로 저장 → 승인 카드 전송(REQ-007).
 * 건너뛰는 모든 경우는 이유와 함께 알리고, 아무것도 저장하지 않는다(몰아서 만들지 않음 — P4).
 */
export async function runDailyDraft(deps: {
  now: () => Date;
  sources: readonly ProductSource[];
  generator: BodyGenerator;
  store: DraftStore;
  notify: (text: string) => Promise<void>;
  /** REQ-007: 만들어진 초안을 `발행/수정/폐기` 버튼이 달린 승인 카드로 보낸다. */
  deliverCard: (draft: Draft) => Promise<void>;
  /** REQ-016: 책 후기 수집기. 없으면 "후기 근거 없음"으로 만든다. */
  reviewCollector?: ReviewCollector;
  /** 후기 수집이 실패했을 때 이유를 남기는 곳(초안은 계속 만든다). */
  onReviewFailure?: (reason: string) => void;
  /** REQ-029: 책 필사 문구 수집기. 없으면 소개문·없음으로 만든다. */
  quoteCollector?: QuoteCollector;
  onQuoteFailure?: (reason: string) => void;
}): Promise<DailyDraftResult> {
  const { now, sources, generator, store, notify } = deps;
  const skip = async (reason: SkipReason, text: string): Promise<DailyDraftResult> => {
    await notify(text);
    return { status: "skipped", reason };
  };

  const pending = store.countPending();
  if (isPendingCapReached(pending)) {
    return skip("pending_cap", `승인 대기 초안이 ${pending}개라 오늘은 새 초안을 만들지 않았어요. 대기 중인 초안을 먼저 처리해 주세요.`);
  }
  if (isBudgetExceeded(store.getMonthCostKrw())) {
    return skip("budget", "이번 달 LLM 비용 상한에 닿아 오늘은 초안을 만들지 않았어요. 링크 모드로 직접 요청하는 글도 상한이 풀릴 때까지 쉬어요.");
  }

  const available = [...new Set(sources.flatMap((source) => source.categories))];
  const category = nextCategory(store.getLastCategory(), available);
  const source = category === null ? undefined : sources.find((candidate) => candidate.categories.includes(category));
  if (category === null || source === undefined) {
    return skip("no_source", "자동으로 상품을 가져올 소스가 없어요. 상품 링크를 보내주시면 그 글을 바로 만들어 드려요.");
  }

  let candidates: Product[];
  try {
    candidates = await source.fetchCandidates(category);
  } catch (error) {
    return skip("source_error", `상품 데이터를 가져오지 못해 오늘은 건너뛰었어요: ${messageOf(error)}`);
  }

  const fresh = filterRecentlyCovered(candidates, store.listCovered(), now(), DEDUP_DAYS);
  const needed = PRODUCTS_PER_DRAFT[category];
  if (fresh.length < needed) {
    return skip("no_candidates", `새로 쓸 상품이 부족해서(${fresh.length}/${needed}) 오늘은 건너뛰었어요.`);
  }
  const picked = fresh.slice(0, needed);

  const reviews = await gatherReviews(category, picked, deps.reviewCollector, deps.onReviewFailure);
  const quote = await gatherQuote(category, picked, null, deps.quoteCollector, deps.onQuoteFailure);
  let generated: Awaited<ReturnType<typeof generateDraftBody>>;
  try {
    generated = await generateDraftBody({
      generator,
      category,
      products: picked,
      memo: null,
      ...(category === "book" ? { quote: quote.quote } : {}),
      ...(reviews.reviewNotes === undefined ? {} : { reviewNotes: reviews.reviewNotes }),
      ...(reviews.reviewExcerpts === undefined ? {} : { reviewExcerpts: reviews.reviewExcerpts }),
    });
  } catch (error) {
    return skip("generation_error", `초안 생성에 실패해 오늘은 건너뛰었어요: ${messageOf(error)}`);
  }

  const draft = store.saveDraft(
    {
      category,
      mode: "daily",
      status: "awaiting_approval",
      products: picked,
      body: generated.body,
      memo: null,
      quality: generated.quality,
      ...(reviews.reviewSources === undefined ? {} : { reviewSources: reviews.reviewSources }),
      ...(quote.quoteSources === undefined ? {} : { quoteSources: quote.quoteSources }),
    },
    picked,
  );
  await deliverCardSafely(deps, draft);
  return { status: "created", draft };
}
