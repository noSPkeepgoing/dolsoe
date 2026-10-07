import { describe, expect, it, vi } from "vitest";

import type { ApplianceBody, BookBody, DraftBody, Product } from "@contract/domain.js";
import { REGENERATE_MAX_RETRIES } from "@contract/domain.js";

import { GenerationError, generateDraftBody, type BodyGenerator } from "./generate.js";

const product = (externalId: string): Product => ({
  externalId,
  source: "coupang_link",
  category: "appliance",
  affiliate: "coupang",
  title: `제품 ${externalId}`,
  url: "https://example.com/" + externalId,
  priceKrw: 100000,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: {},
});
const PRODUCTS = [product("1"), product("2")];

const body = (over: Partial<ApplianceBody> = {}): ApplianceBody => ({
  category: "appliance",
  title: "공기청정기 2종 비교",
  verdict: "가성비는 1번",
  comparison: { headers: ["제품", "가격"], rows: [["제품 1", "10만원"], ["제품 2", "20만원"]] },
  recommendations: [{ forWhom: "원룸", productExternalId: "1", reason: "작음" }],
  experienceLine: null,
  ...over,
});

const generatorReturning = (...bodies: DraftBody[]): BodyGenerator & { generateBody: ReturnType<typeof vi.fn> } => {
  const queue = [...bodies];
  return { generateBody: vi.fn(async () => queue.shift() ?? bodies[bodies.length - 1]!) };
};

describe("generateDraftBody", () => {
  it("[REQ-002][REQ-015] 깨끗한 본문은 한 번에 통과하고 품질 결과가 붙는다", async () => {
    const generator = generatorReturning(body());
    const result = await generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null });
    expect(generator.generateBody).toHaveBeenCalledTimes(1);
    expect(result.quality).toEqual({ bannedPhrasesFound: [], hasExperienceLine: false });
  });

  it("[REQ-015] 금지 표현이 있으면 문제 표현을 알려주며 1회 자동 재생성하고, 깨끗해지면 그 결과를 쓴다", async () => {
    const generator = generatorReturning(body({ verdict: "에 대해 알아보겠습니다" }), body());
    const result = await generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null });
    expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
    expect(generator.generateBody.mock.calls[1]?.[0]).toMatchObject({ avoidPhrases: ["에 대해 알아보겠습니다"] });
    expect(result.quality.bannedPhrasesFound).toEqual([]);
  });

  it("[REQ-015] 재생성 후에도 금지 표현이 남으면 차단하지 않고 개수를 담아 돌려준다(판단은 사람)", async () => {
    const dirty = body({ verdict: "에 대해 알아보겠습니다" });
    const generator = generatorReturning(dirty, dirty);
    const result = await generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null });
    expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
    expect(result.quality.bannedPhrasesFound).toEqual(["에 대해 알아보겠습니다"]);
  });

  it("[REQ-002] 없는 상품을 가리키는 본문은 문제를 알려주며 재생성하고, 계속 틀리면 GenerationError", async () => {
    const wrong = body({ recommendations: [{ forWhom: "x", productExternalId: "999", reason: "r" }] });
    const generator = generatorReturning(wrong, wrong);
    await expect(
      generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null }),
    ).rejects.toBeInstanceOf(GenerationError);
    expect(generator.generateBody.mock.calls[1]?.[0].problems.join(" ")).toMatch(/999/);
  });

  it("[REQ-002] 생성기가 다른 카테고리 본문을 주면 GenerationError", async () => {
    const generator = generatorReturning({
      category: "book",
      title: "t",
      synopsis: "s",
      mood: "m",
      recommendedFor: "r",
      highlights: "h",
      experienceLine: null,
    });
    await expect(
      generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null }),
    ).rejects.toBeInstanceOf(GenerationError);
  });

  it("[REQ-011] 처음 생성할 때 모델이 경험 문장을 지어 넣었으면(경험 한 줄은 내가 준 것만) 비워서 돌려준다", async () => {
    const generator = generatorReturning(body({ experienceLine: "써보니 정말 좋았어요" }));
    const result = await generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null });
    expect(result.body.experienceLine).toBeNull();
    expect(result.quality.hasExperienceLine).toBe(false);
  });
});

describe("generateDraftBody — 책 한 권 리뷰(REQ-016)", () => {
  const INTRO = "무라카미 하루키가 삼 년 만에 내놓은 장편으로 좋은 이야기란 무엇인가라는 질문에 답을 담았다";
  const bookProduct: Product = {
    ...product("1"),
    source: "yes24",
    category: "book",
    affiliate: "yes24",
    title: "가호",
    bookDetail: { introduction: INTRO, tableOfContents: null },
  };
  const bookBody = (over: Partial<BookBody> = {}): BookBody => ({
    category: "book",
    title: "하루키의 새 장편",
    synopsis: "한 남자가 오래된 기억을 따라가는 이야기예요.",
    mood: "잔잔하고 쓸쓸해요.",
    recommendedFor: "천천히 읽는 소설을 좋아하는 분께요.",
    highlights: "후기마다 마지막 장면의 여운을 이야기해요.",
    experienceLine: null,
    ...over,
  });
  const run = (generator: BodyGenerator, reviewNotes?: string) =>
    generateDraftBody({ generator, category: "book", products: [bookProduct], memo: null, ...(reviewNotes === undefined ? {} : { reviewNotes }) });

  it("[REQ-016] 후기 노트를 생성기에 넘긴다", async () => {
    const generator = generatorReturning(bookBody());
    await run(generator, "- 분위기: 잔잔하다는 평");
    expect(generator.generateBody.mock.calls[0]?.[0]).toMatchObject({ reviewNotes: "- 분위기: 잔잔하다는 평" });
  });

  it("[REQ-016] 직접 인용·소개문 복사는 문제를 알려주며 1회 재생성하고, 고쳐지면 그 결과를 쓴다", async () => {
    const quoted = bookBody({ highlights: '한 독자는 "마지막 장면이 오래 남는다"고 했어요.' });
    const copied = bookBody({ synopsis: "삼 년 만에 내놓은 장편으로 좋은 이야기란 무엇인가라는 질문에 답해요" });
    for (const bad of [quoted, copied]) {
      const generator = generatorReturning(bad, bookBody());
      const result = await run(generator);
      expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
      expect(generator.generateBody.mock.calls[1]?.[0].problems.join(" ")).toMatch(/인용|소개문/);
      expect(result.body).toEqual(bookBody());
    }
  });

  it("[REQ-016] 후기 원문 조각을 그대로 옮기면 문제를 알려주며 재생성한다(원문 조각은 생성기에 보내지 않는다)", async () => {
    const excerpt = "깨달음은 가르칠 수 없고 직접 체험으로만 알 수 있다";
    const copied = bookBody({ highlights: `독자들은 ${excerpt}고 해요.` });
    const generator = generatorReturning(copied, bookBody());
    const result = await generateDraftBody({ generator, category: "book", products: [bookProduct], memo: null, reviewNotes: "- 메모", reviewExcerpts: [excerpt] });
    expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
    expect(generator.generateBody.mock.calls[1]?.[0].problems.join(" ")).toMatch(/후기 원문/);
    expect(JSON.stringify(generator.generateBody.mock.calls[0]?.[0])).not.toContain(excerpt);
    expect(result.body).toEqual(bookBody());
  });

  it("[REQ-016] 재생성 후에도 인용·복사가 남으면 GenerationError(깨진 초안을 승인 요청으로 보내지 않는다)", async () => {
    const quoted = bookBody({ mood: "“여운이 길다”고들 해요" });
    await expect(run(generatorReturning(quoted, quoted))).rejects.toBeInstanceOf(GenerationError);
  });

  it("[REQ-002] 깨끗한 한 권 리뷰는 한 번에 통과한다(본문이 상품 ID를 가리키지 않아도 된다)", async () => {
    const generator = generatorReturning(bookBody());
    const result = await run(generator);
    expect(generator.generateBody).toHaveBeenCalledTimes(1);
    expect(result.quality).toEqual({ bannedPhrasesFound: [], hasExperienceLine: false });
  });
});

describe("generateDraftBody — 수정(revision)", () => {
  const previous = body({ verdict: "이전 결론" });
  const revision = (over: { instruction?: string; experienceLine?: string | null; previousBody?: DraftBody } = {}) => ({
    previousBody: over.previousBody ?? previous,
    instruction: over.instruction ?? "표를 더 간단히",
    experienceLine: over.experienceLine ?? null,
  });
  const run = (generator: BodyGenerator, rev: ReturnType<typeof revision>) =>
    generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null, revision: rev });

  it("[REQ-008] 이전 본문과 수정 지시를 생성기에 넘기고, 새 본문을 돌려준다", async () => {
    const generator = generatorReturning(body({ verdict: "새 결론" }));
    const result = await run(generator, revision());
    expect(generator.generateBody.mock.calls[0]?.[0]).toMatchObject({ revision: { instruction: "표를 더 간단히", previousBody: previous } });
    expect((result.body as ApplianceBody).verdict).toBe("새 결론");
  });

  it("[REQ-011] 내가 준 경험 문장이 원문 그대로 들어 있으면 통과하고 '경험 있음'으로 기록한다", async () => {
    const generator = generatorReturning(body({ experienceLine: "소음이 생각보다 컸어요" }));
    const result = await run(generator, revision({ experienceLine: "소음이 생각보다 컸어요" }));
    expect(result.body.experienceLine).toBe("소음이 생각보다 컸어요");
    expect(result.quality.hasExperienceLine).toBe(true);
  });

  it("[REQ-011] 경험 문장이 바뀌어 오면 문제를 알려주며 1회 재시도하고, 원문대로 오면 통과한다", async () => {
    const generator = generatorReturning(body({ experienceLine: "소음이 좀 컸어요" }), body({ experienceLine: "소음이 생각보다 컸어요" }));
    const result = await run(generator, revision({ experienceLine: "소음이 생각보다 컸어요" }));
    expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
    expect(generator.generateBody.mock.calls[1]?.[0].problems.join(" ")).toContain("소음이 생각보다 컸어요");
    expect(result.body.experienceLine).toBe("소음이 생각보다 컸어요");
  });

  it("[REQ-011] 재시도 후에도 경험 문장이 없거나 바뀌어 있으면 GenerationError(실패 알림)", async () => {
    const generator = generatorReturning(body({ experienceLine: null }));
    await expect(run(generator, revision({ experienceLine: "소음이 생각보다 컸어요" }))).rejects.toBeInstanceOf(GenerationError);
  });

  it("[REQ-011] 이번 지시에 경험 문장이 없으면 이전 초안의 내 경험 문장을 그대로 유지한다(데이터 유실 금지)", async () => {
    const withExperience = body({ experienceLine: "이전에 내가 준 경험" });
    const generator = generatorReturning(body({ experienceLine: "이전에 내가 준 경험" }));
    const result = await run(generator, revision({ previousBody: withExperience }));
    expect(result.body.experienceLine).toBe("이전에 내가 준 경험");
  });

  it("[REQ-011] 내가 준 적 없는데 모델이 경험 문장을 새로 지어 넣으면 거부(재시도 후 실패)", async () => {
    const generator = generatorReturning(body({ experienceLine: "써보니 정말 좋았어요" }));
    await expect(run(generator, revision())).rejects.toBeInstanceOf(GenerationError);
  });
});

describe("generateDraftBody — 지어낸 후기(REQ-011)", () => {
  it("[REQ-011] 봇이 후기를 지어내면 문제로 알려 1회 재시도하고, 깨끗해지면 통과한다", async () => {
    const generator = generatorReturning(body({ verdict: "직접 써보니 조용해요" }), body());
    await generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null });
    expect(generator.generateBody).toHaveBeenCalledTimes(1 + REGENERATE_MAX_RETRIES);
    expect(generator.generateBody.mock.calls[1]?.[0].problems.join(" ")).toMatch(/후기|경험/);
  });

  it("[REQ-011] 재시도 후에도 후기가 남으면 차단한다(GenerationError)", async () => {
    const generator = generatorReturning(body({ verdict: "직접 써보니 조용해요" }));
    await expect(generateDraftBody({ generator, category: "appliance", products: PRODUCTS, memo: null })).rejects.toBeInstanceOf(GenerationError);
  });

  it("[REQ-011] 수정에서 '경험 한 줄: 없음'(clearExperience)이면 이전 경험 문장을 지우고 null이어야 통과한다", async () => {
    const previousBody = body({ experienceLine: "이전 경험" });
    const generator = generatorReturning(body({ experienceLine: null }));
    const result = await generateDraftBody({
      generator,
      category: "appliance",
      products: PRODUCTS,
      memo: null,
      revision: { previousBody, instruction: "경험 한 줄: 없음", experienceLine: null, clearExperience: true },
    });
    expect(result.body.experienceLine).toBeNull();
    expect(result.quality.hasExperienceLine).toBe(false);
  });
});
