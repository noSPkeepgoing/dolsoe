import { describe, expect, it, vi } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { MAX_PENDING_DRAFTS, MONTHLY_LLM_BUDGET_KRW, PRODUCTS_PER_DRAFT } from "@contract/domain.js";

import type { NewDraft } from "../db.js";
import type { BodyGenerator, GenerateBodyInput } from "../draft/generate.js";
import type { ReviewCollector } from "../draft/review.js";
import type { QuoteCollector } from "../draft/quote.js";
import type { SpecCollector } from "../draft/spec.js";

import type { DraftStore } from "./daily-draft.js";
import { runLinkDraft } from "./link-draft.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const COUPANG = "https://link.coupang.com/a/abc123";
const YES24 = "https://www.yes24.com/Product/Goods/900000001";

const yes24Product = (id: string): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}`,
  priceKrw: 15000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});

const bodyFor = (input: GenerateBodyInput): DraftBody =>
  input.category === "book"
    ? {
        category: "book",
        title: "책 소개",
        synopsis: "s",
        mood: "m",
        recommendedFor: "r",
        highlights: "h",
        experienceLine: null,
      }
    : {
        category: "appliance",
        title: "제품 소개",
        verdict: "결론",
        comparison: { headers: ["제품", "가격"], rows: input.products.map((p) => [p.title, "1만원"]) },
        recommendations: [{ forWhom: "누구나", productExternalId: input.products[0]!.externalId, reason: "이유" }],
        experienceLine: null,
      };

function setup(over: { costKrw?: number; pending?: number; resolveYes24?: (id: string) => Promise<Product>; generator?: BodyGenerator; reviewCollector?: ReviewCollector; specCollector?: SpecCollector; quoteCollector?: QuoteCollector } = {}) {
  const saved: NewDraft[] = [];
  const store: DraftStore = {
    countPending: () => over.pending ?? 0,
    getLastCategory: () => null,
    listCovered: () => [],
    getMonthCostKrw: () => over.costKrw ?? 0,
    saveDraft: (draft): Draft => {
      saved.push(draft);
      return { ...draft, id: saved.length, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as Draft;
    },
  };
  const generator: BodyGenerator = over.generator ?? { generateBody: vi.fn(async (input: GenerateBodyInput) => bodyFor(input)) };
  const notify = vi.fn<(text: string) => Promise<void>>(async () => {});
  const deliverCard = vi.fn<(draft: Draft) => Promise<void>>(async () => {});
  const resolveYes24 = over.resolveYes24 ?? vi.fn(async (id: string) => yes24Product(id));
  const run = (text: string) =>
    runLinkDraft({ now: () => NOW, store, generator, resolveYes24, notify, deliverCard, ...(over.reviewCollector === undefined ? {} : { reviewCollector: over.reviewCollector }), ...(over.specCollector === undefined ? {} : { specCollector: over.specCollector }), ...(over.quoteCollector === undefined ? {} : { quoteCollector: over.quoteCollector }) }, text);
  return { saved, notify, deliverCard, generator, resolveYes24, run };
}

describe("runLinkDraft", () => {
  it("[REQ-006] 쿠팡 링크+상품명+메모를 보내면 그 상품 기준의 링크 모드 초안이 승인 요청으로 온다", async () => {
    const { saved, deliverCard, generator, run } = setup();
    const result = await run(`${COUPANG}\n삼성 비스포크 제트 / 899000원\n소음 중요`);

    expect(result.status).toBe("created");
    expect(saved[0]).toMatchObject({
      category: "appliance",
      mode: "link",
      status: "awaiting_approval",
      memo: "소음 중요",
      products: [{ title: "삼성 비스포크 제트", url: COUPANG, priceKrw: 899000 }],
    });
    expect(vi.mocked(generator.generateBody).mock.calls[0]![0]).toMatchObject({ memo: "소음 중요" });
    expect(deliverCard).toHaveBeenCalledTimes(1);
  });

  it("[REQ-006] 시작을 바로 알린다(생성에 시간이 걸리므로)", async () => {
    const { notify, run } = setup();
    await run(`${COUPANG}\n제품`);
    expect(notify.mock.calls[0]![0]).toContain("만드는 중");
  });

  it("[REQ-006] YES24 링크는 상품번호로 조회해 책 초안을 만든다", async () => {
    const { saved, resolveYes24, run } = setup();
    await run(YES24);
    expect(resolveYes24).toHaveBeenCalledWith("900000001");
    expect(saved[0]).toMatchObject({ category: "book", mode: "link", memo: null });
  });

  it("[REQ-016] YES24 책 링크는 후기도 수집해 노트와 출처를 반영하고, 쿠팡(가전) 링크는 수집하지 않는다", async () => {
    const reviewCollector: ReviewCollector = { collect: vi.fn(async () => ({ notes: "- 메모", sources: ["https://blog.example.com/a"] })) };
    const book = setup({ reviewCollector });
    await book.run(YES24);
    expect(reviewCollector.collect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(book.generator.generateBody).mock.calls[0]![0]).toMatchObject({ reviewNotes: "- 메모" });
    expect(book.saved[0]).toMatchObject({ reviewSources: ["https://blog.example.com/a"] });

    const appliance = setup({ reviewCollector });
    await appliance.run(`${COUPANG}\n제품`);
    expect(reviewCollector.collect).toHaveBeenCalledTimes(1);
  });

  it("[REQ-016] 후기 수집이 실패해도 링크 모드 책 초안은 만든다", async () => {
    const reviewCollector: ReviewCollector = { collect: async () => { throw new Error("검색 서버 오류"); } };
    const { saved, run } = setup({ reviewCollector });
    await expect(run(YES24)).resolves.toMatchObject({ status: "created" });
    expect(saved[0]).toMatchObject({ reviewSources: [] });
  });

  it("[REQ-002] 책은 한 권짜리 글이라 YES24 링크를 여러 개 보내면 안내한다(B3)", async () => {
    const { saved, run } = setup();
    await expect(run(`${YES24}\nhttps://www.yes24.com/Product/Goods/900000002`)).resolves.toEqual({ status: "skipped", reason: "too_many" });
    expect(saved).toEqual([]);
  });

  it("[REQ-006] 링크가 없는 메시지는 아무것도 하지 않고 not_link로 알려준다(안내는 호출 쪽)", async () => {
    const { notify, saved, run } = setup();
    await expect(run("안녕")).resolves.toEqual({ status: "skipped", reason: "not_link" });
    expect(notify).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("[REQ-006] 지원하지 않는 링크는 안내 메시지만 오고 초안은 없다", async () => {
    const { notify, saved, run } = setup();
    await expect(run("https://example.com/a")).resolves.toEqual({ status: "skipped", reason: "unsupported" });
    expect(notify.mock.calls[0]![0]).toMatch(/지원하지 않는|지원하지 않아/);
    expect(notify.mock.calls[0]![0]).toContain("link.coupang.com");
    expect(saved).toEqual([]);
  });

  it("[REQ-006] 쿠팡 링크에 상품명이 없으면 상품명을 달라고 안내한다", async () => {
    const { notify, run } = setup();
    await expect(run(COUPANG)).resolves.toEqual({ status: "skipped", reason: "missing_title" });
    expect(notify.mock.calls[0]![0]).toContain("상품명");
  });

  it("[REQ-006] 쿠팡과 YES24를 한 메시지에 섞으면 한 종류씩 보내달라고 안내한다", async () => {
    const { notify, saved, run } = setup();
    await expect(run(`${COUPANG}\n제품\n${YES24}`)).resolves.toEqual({ status: "skipped", reason: "mixed" });
    expect(notify.mock.calls[0]![0]).toContain("한 종류");
    expect(saved).toEqual([]);
  });

  it("[REQ-006] 한 편에 쓸 수 있는 상품 수를 넘으면 안내한다", async () => {
    const { saved, run } = setup();
    const links = Array.from({ length: PRODUCTS_PER_DRAFT.appliance + 1 }, (_, i) => `https://link.coupang.com/a/c${i}\n제품 ${i}`);
    await expect(run(links.join("\n"))).resolves.toEqual({ status: "skipped", reason: "too_many" });
    expect(saved).toEqual([]);
  });

  it("[REQ-004] 링크 모드는 승인 대기 상한의 예외다 — 대기 초안이 상한이어도 만든다", async () => {
    const { run } = setup({ pending: MAX_PENDING_DRAFTS });
    await expect(run(`${COUPANG}\n제품`)).resolves.toMatchObject({ status: "created" });
  });

  it("[NFR-001] 월 비용 상한에 닿으면 링크 모드도 쉰다", async () => {
    const { notify, saved, run } = setup({ costKrw: MONTHLY_LLM_BUDGET_KRW });
    await expect(run(`${COUPANG}\n제품`)).resolves.toEqual({ status: "skipped", reason: "budget" });
    expect(notify.mock.calls[0]![0]).toContain("비용");
    expect(saved).toEqual([]);
  });

  it("[REQ-006] YES24 조회가 실패하면 이유를 알리고 초안은 저장하지 않는다", async () => {
    const { notify, saved, run } = setup({ resolveYes24: async () => { throw new Error("YES24 API GOODS_001: 상품 없음"); } });
    await expect(run(YES24)).resolves.toEqual({ status: "skipped", reason: "source_error" });
    expect(notify.mock.calls.at(-1)![0]).toContain("GOODS_001");
    expect(saved).toEqual([]);
  });

  it("[REQ-006] 생성에 실패하면 이유를 알리고 초안은 저장하지 않는다", async () => {
    const generator: BodyGenerator = { generateBody: vi.fn(async () => { throw new Error("모델 거절"); }) };
    const { notify, saved, run } = setup({ generator });
    await expect(run(`${COUPANG}\n제품`)).resolves.toEqual({ status: "skipped", reason: "generation_error" });
    expect(notify.mock.calls.at(-1)![0]).toContain("모델 거절");
    expect(saved).toEqual([]);
  });

  it("[REQ-007] 카드 전송이 실패해도 저장된 초안은 유지하고 번호와 함께 알린다(고아 초안 방지)", async () => {
    const { saved, notify, deliverCard, run } = setup();
    deliverCard.mockRejectedValueOnce(new Error("telegram down"));
    await expect(run(`${COUPANG}\n제품`)).resolves.toMatchObject({ status: "created" });
    expect(saved).toHaveLength(1);
    expect(notify.mock.calls.at(-1)![0]).toMatch(/#1.*telegram down/s);
  });

  describe("스펙 (REQ-028)", () => {
    const evidence = (value: string) => [
      { url: "https://a.example/1", excerpt: `용량 ${value}` },
      { url: "https://b.example/1", excerpt: `${value} 대용량` },
    ];

    it("[REQ-028] 용량 3개를 적으면 검색 없이 그 값이 상품 스펙·생성기 팩트에 들어가고 카드는 '직접 입력'이다", async () => {
      const specCollector: SpecCollector = { collect: vi.fn(async () => ({ candidates: [], evidence: [] })) };
      const { saved, generator, run } = setup({ specCollector });
      await run(`${COUPANG}\nA 에어프라이어 / 59000 / 용량 3.5L\nhttps://link.coupang.com/a/b2\nB 에어프라이어 / 89000 / 용량 5L\nhttps://link.coupang.com/a/c3\nC 에어프라이어 / 129000 / 용량 12L`);
      expect(specCollector.collect).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({ specOrigin: { user: 3, web: 0 }, products: [{ specs: { 용량: "3.5L" } }, { specs: { 용량: "5L" } }, { specs: { 용량: "12L" } }] });
      const facts = vi.mocked(generator.generateBody).mock.calls[0]![0].facts?.map((f) => f.id);
      expect(facts).toEqual(expect.arrayContaining(["capacity_max", "price_per_liter_min"]));
    });

    it("[REQ-028] 가격만 적고 웹 확인도 안 되면 용량 판단 팩트가 없고 카드는 '확인 못 함'이다", async () => {
      const specCollector: SpecCollector = { collect: vi.fn(async () => ({ candidates: [{ key: "용량", value: "9L" }], evidence: [evidence("9L")[0]!] })) };
      const { saved, generator, run } = setup({ specCollector });
      await run(`${COUPANG}\nA 에어프라이어 / 59000\nhttps://link.coupang.com/a/b2\nB 에어프라이어 / 89000`);
      expect(saved[0]).toMatchObject({ specOrigin: { user: 0, web: 0 } });
      expect(saved[0]!.specSources).toBeUndefined();
      expect(vi.mocked(generator.generateBody).mock.calls[0]![0].facts?.map((f) => f.id)).toEqual(["price_min"]);
    });

    it("[REQ-028] 웹에서 2곳 확인된 값은 빈 칸에 채우고 출처 URL은 DB 필드(specSources)에만 둔다", async () => {
      const specCollector: SpecCollector = { collect: vi.fn(async () => ({ candidates: [{ key: "용량", value: "5L" }], evidence: evidence("5L") })) };
      const { saved, run } = setup({ specCollector });
      await run(`${COUPANG}\nA 에어프라이어 / 59000`);
      expect(saved[0]).toMatchObject({ specOrigin: { user: 0, web: 1 }, specSources: ["https://a.example/1", "https://b.example/1"], products: [{ specs: { 용량: "5L" } }] });
      expect(JSON.stringify(saved[0]!.body)).not.toContain("a.example");
    });

    it("[REQ-028] 책 링크는 스펙을 수집하지 않고 스펙 출처 필드도 남기지 않는다", async () => {
      const specCollector: SpecCollector = { collect: vi.fn(async () => ({ candidates: [], evidence: [] })) };
      const { saved, run } = setup({ specCollector });
      await run(YES24);
      expect(specCollector.collect).not.toHaveBeenCalled();
      expect(saved[0]!.specOrigin).toBeUndefined();
    });
  });

  describe("필사 문구 (REQ-029)", () => {
    const SENTENCE = "오늘 하루도 충분히 애썼어요.";
    const quoteCollector = (sites: number): QuoteCollector => ({
      collect: vi.fn(async () => ({
        candidates: [SENTENCE],
        evidence: Array.from({ length: sites }, (_, i) => ({ url: `https://site${i}.example/p`, excerpt: SENTENCE })),
      })),
    });

    it("[REQ-029] 책 링크 메시지의 '문구:' 줄은 사용자 문구로 쓰이고 메모에서는 빠지며 검색하지 않는다", async () => {
      const c = quoteCollector(2);
      const { saved, generator, run } = setup({ quoteCollector: c });
      await run(`${YES24}\n잔잔한 책이면 좋겠어요\n문구: “내가 고른 문장이에요.”`);
      expect(c.collect).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({ memo: "잔잔한 책이면 좋겠어요", body: { quote: { text: "내가 고른 문장이에요.", origin: "user" } } });
      expect(vi.mocked(generator.generateBody).mock.calls[0]![0]).toMatchObject({ memo: "잔잔한 책이면 좋겠어요" });
    });

    it("[REQ-029] 문구를 안 주면 웹 2곳 확인 문장이 들어가고 출처 URL은 quoteSources에만 남는다", async () => {
      const { saved, run } = setup({ quoteCollector: quoteCollector(2) });
      await run(YES24);
      expect(saved[0]).toMatchObject({ body: { quote: { text: SENTENCE, origin: "web" } }, quoteSources: ["https://site0.example/p", "https://site1.example/p"] });
      expect(JSON.stringify(saved[0]!.body)).not.toContain("site0.example");
    });

    it("[REQ-029] 웹 1곳만 확인되고 소개문도 없으면 문구 없이(코너 생략) 만든다", async () => {
      const { saved, run } = setup({ quoteCollector: quoteCollector(1) });
      await run(YES24);
      expect("quote" in saved[0]!.body!).toBe(false);
      expect(saved[0]!.quoteSources).toBeUndefined();
    });

    it("[REQ-029] 가전 링크의 '문구:' 줄은 필사 문구가 아니라 일반 메모다", async () => {
      const { saved, run } = setup();
      await run(`${COUPANG}\n제품 / 100000원\n문구: 이건 메모`);
      expect(saved[0]!.memo).toBe("문구: 이건 메모");
    });
  });
});
