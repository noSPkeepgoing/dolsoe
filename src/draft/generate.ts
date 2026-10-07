import type { Category, DraftBody, Product, QualityReport } from "@contract/domain.js";
import { REGENERATE_MAX_RETRIES } from "@contract/domain.js";

import { checkQuality, findCopyProblems, findExperienceClaims, validateAgainstProducts } from "./quality-check.js";

export class GenerationError extends Error {}

/** REQ-008: 수정 요청이면 이전 본문과 내 지시, 그리고 지켜야 할 내 경험 문장(없으면 null). */
export interface Revision {
  previousBody: DraftBody;
  instruction: string;
  experienceLine: string | null;
  /** "경험 한 줄: 없음" — 이전에 넣은 경험 문장을 지운다 */
  clearExperience?: boolean;
}

/** 수정 결과의 경험 한 줄이 가져야 할 값: 지우라 했으면 null, 이번 문장, 없으면 이전 문장 유지(데이터 유실 금지). 프롬프트와 검사가 같은 규칙을 쓴다. */
export function expectedExperienceLine(revision: Revision): string | null {
  if (revision.clearExperience === true) return null;
  return revision.experienceLine ?? revision.previousBody.experienceLine;
}

export interface GenerateBodyInput {
  category: Category;
  products: readonly Product[];
  memo: string | null;
  /** 직전 시도에서 발견된 금지 표현 — 다시 쓰지 말 것 */
  avoidPhrases: string[];
  /** 직전 시도의 골격 문제(없는 상품 ID, 표 불일치 등) — 고칠 것 */
  problems: string[];
  revision?: Revision;
  /** REQ-016 책 후기 근거(의역 노트). 없거나 비면 "후기 근거 없음" */
  reviewNotes?: string;
}

/** LLM 호출 경계. 실제 구현은 src/llm.ts, 테스트는 가짜로 대체한다. */
export interface BodyGenerator {
  generateBody(input: GenerateBodyInput): Promise<DraftBody>;
}

/**
 * 생성 → 골격 검증 → 품질 검사 루프(REQ-002·015·016).
 * - 골격 문제와 직접 인용·URL·소개문 복사(REQ-016)는 재시도 후에도 남으면 실패(GenerationError). 깨진 초안을 승인 요청으로 보내지 않는다.
 * - 금지 표현은 재시도 후에도 남으면 차단하지 않고 결과에 담아 보낸다(판단은 사람, REQ-015).
 * - 경험 한 줄은 사용자가 준 문장만 쓴다(REQ-011): 처음 생성은 항상 비우고, 수정이면 이번 지시의 문장(없으면 이전 초안의 문장)이
 *   원문 그대로 들어 있는지 검사해 어긋나면 1회 재시도 후 GenerationError.
 */
export async function generateDraftBody(input: {
  generator: BodyGenerator;
  category: Category;
  products: readonly Product[];
  memo: string | null;
  revision?: Revision;
  reviewNotes?: string;
  /** REQ-016 후기 원문 조각 — 본문이 그대로 옮기지 않았는지 대조하는 데만 쓴다(생성기에는 보내지 않는다). */
  reviewExcerpts?: readonly string[];
}): Promise<{ body: DraftBody; quality: QualityReport }> {
  const { revision, reviewNotes } = input;
  const expectedExperience = revision === undefined ? null : expectedExperienceLine(revision);
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
      ...(revision === undefined ? {} : { revision }),
      ...(reviewNotes === undefined ? {} : { reviewNotes }),
    });

    if (raw.category !== input.category) {
      problems = [`본문 카테고리(${raw.category})가 요청(${input.category})과 다릅니다`];
      lastProblems = problems;
      avoidPhrases = [];
      continue;
    }

    if (revision !== undefined && raw.experienceLine !== expectedExperience) {
      problems = [
        expectedExperience === null
          ? "경험 한 줄은 내가 준 문장만 쓸 수 있습니다. experienceLine을 null로 두세요"
          : `experienceLine에 다음 문장을 한 글자도 바꾸지 말고 그대로 넣으세요: ${expectedExperience}`,
      ];
      lastProblems = problems;
      avoidPhrases = [];
      continue;
    }

    const body = revision === undefined ? ({ ...raw, experienceLine: null } as DraftBody) : raw;
    // 골격 문제와 지어낸 후기(REQ-011)는 둘 다 재시도 후에도 남으면 차단한다. 금지 표현(REQ-015)만 표시하고 통과시킨다.
    const claims = findExperienceClaims(body).map((claim) => `봇이 지어낸 후기·경험 표현("${claim}")이 있습니다. 데이터에 있는 사실만 쓰세요`);
    const structural = [...validateAgainstProducts(body, input.products), ...findCopyProblems(body, input.products, input.reviewExcerpts), ...claims];
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
