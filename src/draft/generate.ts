import type { Category, DraftBody, Product, QualityReport } from "@contract/domain.js";
import { REGENERATE_MAX_RETRIES } from "@contract/domain.js";

import { checkQuality, validateAgainstProducts } from "./quality-check.js";

export class GenerationError extends Error {}

export interface GenerateBodyInput {
  category: Category;
  products: readonly Product[];
  memo: string | null;
  /** 직전 시도에서 발견된 금지 표현 — 다시 쓰지 말 것 */
  avoidPhrases: string[];
  /** 직전 시도의 골격 문제(없는 상품 ID, 표 불일치 등) — 고칠 것 */
  problems: string[];
}

/** LLM 호출 경계. 실제 구현은 src/llm.ts, 테스트는 가짜로 대체한다. */
export interface BodyGenerator {
  generateBody(input: GenerateBodyInput): Promise<DraftBody>;
}

/**
 * 생성 → 골격 검증 → 품질 검사 루프(REQ-002·015).
 * - 골격 문제는 재시도 후에도 남으면 실패(GenerationError). 깨진 초안을 승인 요청으로 보내지 않는다.
 * - 금지 표현은 재시도 후에도 남으면 차단하지 않고 결과에 담아 보낸다(판단은 사람, REQ-015).
 * - 처음 생성에서는 경험 한 줄을 항상 비운다: 경험은 사용자가 준 문장만 쓴다(REQ-011).
 */
export async function generateDraftBody(input: {
  generator: BodyGenerator;
  category: Category;
  products: readonly Product[];
  memo: string | null;
}): Promise<{ body: DraftBody; quality: QualityReport }> {
  let avoidPhrases: string[] = [];
  let problems: string[] = [];
  let lastProblems: string[] = [];

  for (let attempt = 0; attempt <= REGENERATE_MAX_RETRIES; attempt++) {
    const raw = await input.generator.generateBody({
      category: input.category,
      products: input.products,
      memo: input.memo,
      avoidPhrases,
      problems,
    });

    if (raw.category !== input.category) {
      problems = [`본문 카테고리(${raw.category})가 요청(${input.category})과 다릅니다`];
      lastProblems = problems;
      avoidPhrases = [];
      continue;
    }

    const body = { ...raw, experienceLine: null } as DraftBody;
    const structural = validateAgainstProducts(body, input.products);
    const quality = checkQuality(body);

    if (structural.length > 0) {
      problems = structural;
      lastProblems = structural;
      avoidPhrases = quality.bannedPhrasesFound;
      continue;
    }
    if (quality.bannedPhrasesFound.length > 0 && attempt < REGENERATE_MAX_RETRIES) {
      problems = [];
      avoidPhrases = quality.bannedPhrasesFound;
      continue;
    }
    return { body, quality };
  }

  throw new GenerationError(`초안 생성 실패: ${lastProblems.join("; ")}`);
}
