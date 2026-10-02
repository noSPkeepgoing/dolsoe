import { describe, expect, it, vi } from "vitest";

import type { ApplianceBody, DraftBody, Product } from "@contract/domain.js";
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
      intro: "i",
      items: [{ productExternalId: "1", oneLiner: "o", reason: "r" }],
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
