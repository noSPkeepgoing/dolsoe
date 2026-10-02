import { describe, expect, it, vi } from "vitest";

import type { Category, CoveredProduct, Draft, DraftBody, Product } from "@contract/domain.js";
import { MAX_PENDING_DRAFTS, MONTHLY_LLM_BUDGET_KRW, PRODUCTS_PER_DRAFT } from "@contract/domain.js";

import type { BodyGenerator, GenerateBodyInput } from "../draft/generate.js";
import type { NewDraft } from "../db.js";
import type { ProductSource } from "../sources/product-source.js";

import { runDailyDraft, type DraftStore } from "./daily-draft.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const BOOKS = PRODUCTS_PER_DRAFT.book;

const makeProduct = (id: string, category: Category = "book"): Product => ({
  externalId: id,
  source: category === "book" ? "yes24" : "coupang_link",
  category,
  affiliate: category === "book" ? "yes24" : "coupang",
  title: `상품 ${id}`,
  url: `https://example.com/${id}`,
  priceKrw: 10000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});
const products = (count: number, category: Category = "book", from = 1): Product[] =>
  Array.from({ length: count }, (_, i) => makeProduct(String(from + i), category));

const sourceFor = (category: Category, list: Product[]): ProductSource & { fetchCandidates: ReturnType<typeof vi.fn> } => ({
  categories: [category],
  fetchCandidates: vi.fn(async () => list),
});

const bodyFor = (input: GenerateBodyInput, extra = ""): DraftBody =>
  input.category === "book"
    ? {
        category: "book",
        title: "이번 주 베스트셀러",
        intro: `소개${extra}`,
        items: input.products.map((p) => ({ productExternalId: p.externalId, oneLiner: "한 줄", reason: "이유" })),
        experienceLine: null,
      }
    : {
        category: "appliance",
        title: "비교",
        verdict: `결론${extra}`,
        comparison: { headers: ["제품", "가격"], rows: input.products.map((p) => [p.title, "1만원"]) },
        recommendations: [{ forWhom: "누구나", productExternalId: input.products[0]!.externalId, reason: "이유" }],
        experienceLine: null,
      };

const generatorOk = (extra = ""): BodyGenerator & { generateBody: ReturnType<typeof vi.fn> } => ({
  generateBody: vi.fn(async (input: GenerateBodyInput) => bodyFor(input, extra)),
});

class FakeStore implements DraftStore {
  pending = 0;
  last: Category | null = null;
  covered: CoveredProduct[] = [];
  monthCost = 0;
  saved: { draft: NewDraft; covered: Product[] }[] = [];
  countPending = (): number => this.pending;
  getLastCategory = (): Category | null => this.last;
  listCovered = (): CoveredProduct[] => this.covered;
  getMonthCostKrw = (): number => this.monthCost;
  saveDraft = (draft: NewDraft, covered: Product[]): Draft => {
    this.saved.push({ draft, covered });
    this.last = draft.category;
    return { ...draft, id: this.saved.length, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  };
}

const run = (over: { store?: FakeStore; sources?: ProductSource[]; generator?: BodyGenerator } = {}) => {
  const store = over.store ?? new FakeStore();
  const notify = vi.fn<(text: string) => Promise<void>>(async () => {});
  const deliverCard = vi.fn<(draft: Draft) => Promise<void>>(async () => {});
  const generator = over.generator ?? generatorOk();
  const sources = over.sources ?? [sourceFor("book", products(BOOKS))];
  const result = runDailyDraft({ now: () => NOW, sources, generator, store, notify, deliverCard });
  return { store, notify, deliverCard, generator, sources, result };
};

describe("runDailyDraft", () => {
  it("[REQ-001][REQ-002][REQ-007] 소스에서 후보를 받아 초안을 만들어 승인 대기로 저장하고 승인 카드로 보낸다", async () => {
    const { store, notify, deliverCard, result } = run();
    const outcome = await result;
    expect(outcome.status).toBe("created");
    expect(store.saved).toHaveLength(1);
    const { draft, covered } = store.saved[0]!;
    expect(draft).toMatchObject({ category: "book", mode: "daily", status: "awaiting_approval", memo: null });
    expect(draft.products).toHaveLength(BOOKS);
    expect(draft.body?.category).toBe("book");
    expect(covered.map((p) => p.externalId)).toEqual(draft.products.map((p) => p.externalId));
    expect(notify).not.toHaveBeenCalled(); // 텍스트 알림이 아니라 버튼 달린 카드로 보낸다
    expect(deliverCard).toHaveBeenCalledTimes(1);
    expect(deliverCard.mock.calls[0]![0]).toMatchObject({ id: 1, status: "awaiting_approval", body: { title: "이번 주 베스트셀러" } });
  });

  it("[REQ-001] 가전·책 소스가 모두 있으면 마지막 생성의 반대 카테고리로 번갈아 만든다", async () => {
    const appliance = sourceFor("appliance", products(PRODUCTS_PER_DRAFT.appliance, "appliance"));
    const book = sourceFor("book", products(BOOKS));
    const afterAppliance = new FakeStore();
    afterAppliance.last = "appliance";
    await run({ store: afterAppliance, sources: [appliance, book] }).result;
    expect(afterAppliance.saved[0]!.draft.category).toBe("book");

    const afterBook = new FakeStore();
    afterBook.last = "book";
    await run({ store: afterBook, sources: [appliance, book] }).result;
    expect(afterBook.saved[0]!.draft.category).toBe("appliance");
  });

  it("[REQ-004] 승인 대기가 상한 이상이면 소스도 LLM도 부르지 않고 알린다", async () => {
    const store = new FakeStore();
    store.pending = MAX_PENDING_DRAFTS;
    const { notify, generator, sources, result } = run({ store });
    expect(await result).toEqual({ status: "skipped", reason: "pending_cap" });
    expect(notify.mock.calls[0]![0]).toContain(String(MAX_PENDING_DRAFTS));
    expect((sources[0] as ReturnType<typeof sourceFor>).fetchCandidates).not.toHaveBeenCalled();
    expect(generator.generateBody).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });

  it("[REQ-004] 상한 바로 아래(2개 대기)면 계속 만든다", async () => {
    const store = new FakeStore();
    store.pending = MAX_PENDING_DRAFTS - 1;
    expect((await run({ store }).result).status).toBe("created");
  });

  it("[REQ-005] 상품 소스가 실패하면 그날은 건너뛰고 이유와 함께 알린다(초안·순서 기록 없음)", async () => {
    const failing: ProductSource = { categories: ["book"], fetchCandidates: vi.fn(async () => { throw new Error("YES24 API AUTH_002"); }) };
    const { store, notify, result } = run({ sources: [failing] });
    expect(await result).toEqual({ status: "skipped", reason: "source_error" });
    expect(notify.mock.calls[0]![0]).toContain("AUTH_002");
    expect(store.saved).toHaveLength(0);
    expect(store.last).toBeNull();
  });

  it("[REQ-005] 후보가 비었거나 한 편에 모자라면 건너뛰고 알린다", async () => {
    const empty = run({ sources: [sourceFor("book", [])] });
    expect(await empty.result).toEqual({ status: "skipped", reason: "no_candidates" });
    expect(empty.notify).toHaveBeenCalledTimes(1);

    const short = run({ sources: [sourceFor("book", products(BOOKS - 1))] });
    expect(await short.result).toEqual({ status: "skipped", reason: "no_candidates" });
    expect(short.notify.mock.calls[0]![0]).toContain("부족");
  });

  it("[REQ-005] 자동 소스가 하나도 없으면 링크 모드를 안내하고 건너뛴다", async () => {
    const { notify, result } = run({ sources: [] });
    expect(await result).toEqual({ status: "skipped", reason: "no_source" });
    expect(notify.mock.calls[0]![0]).toContain("링크");
  });

  it("[REQ-003] 최근에 다룬 상품은 빼고, 남은 상품만으로 초안을 만든다", async () => {
    const store = new FakeStore();
    store.covered = [
      { source: "yes24", externalId: "1", coveredAt: new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString() },
      { source: "yes24", externalId: "2", coveredAt: new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString() },
    ];
    const { result } = run({ store, sources: [sourceFor("book", products(BOOKS + 2))] });
    expect((await result).status).toBe("created");
    const ids = store.saved[0]!.draft.products.map((p) => p.externalId);
    expect(ids).not.toContain("1");
    expect(ids).not.toContain("2");
    expect(ids).toHaveLength(BOOKS);
  });

  it("[REQ-003] 다룬 상품을 빼고 나면 한 편에 모자라면 건너뛴다", async () => {
    const store = new FakeStore();
    store.covered = [{ source: "yes24", externalId: "1", coveredAt: NOW.toISOString() }];
    const { result } = run({ store, sources: [sourceFor("book", products(BOOKS))] });
    expect(await result).toEqual({ status: "skipped", reason: "no_candidates" });
  });

  it("[REQ-015] 금지 표현이 남은 초안도 저장하고 카드로 보낸다(품질 결과는 초안에 담겨 카드에 표시)", async () => {
    const generator = generatorOk("에 대해 알아보겠습니다");
    const { store, deliverCard, result } = run({ generator });
    expect((await result).status).toBe("created");
    expect(store.saved[0]!.draft.quality?.bannedPhrasesFound).toEqual(["에 대해 알아보겠습니다"]);
    expect(deliverCard.mock.calls[0]![0].quality?.bannedPhrasesFound).toEqual(["에 대해 알아보겠습니다"]);
  });

  it("[NFR-001] 이번 달 LLM 비용이 상한에 닿았으면 만들지 않고 알린다", async () => {
    const store = new FakeStore();
    store.monthCost = MONTHLY_LLM_BUDGET_KRW;
    const { generator, notify, result } = run({ store });
    expect(await result).toEqual({ status: "skipped", reason: "budget" });
    expect(generator.generateBody).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("[REQ-005] 초안 생성이 실패하면 아무것도 저장하지 않고(다룬 상품도 기록 안 함) 알린다", async () => {
    const generator: BodyGenerator = { generateBody: vi.fn(async () => { throw new Error("모델 거절"); }) };
    const { store, notify, result } = run({ generator });
    expect(await result).toEqual({ status: "skipped", reason: "generation_error" });
    expect(notify.mock.calls[0]![0]).toContain("모델 거절");
    expect(store.saved).toHaveLength(0);
  });

  it("[REQ-007] 카드 전송이 실패해도 저장된 초안은 유지하고 번호와 함께 알린다(고아 초안 방지)", async () => {
    const { store, notify, deliverCard, result } = run();
    deliverCard.mockRejectedValueOnce(new Error("telegram down"));
    expect((await result).status).toBe("created");
    expect(store.saved).toHaveLength(1);
    expect(notify.mock.calls.at(-1)![0]).toMatch(/#1.*telegram down/s);
  });
});
