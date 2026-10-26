import { describe, expect, it } from "vitest";

import type { Product } from "@contract/domain.js";
import { BANNED_PHRASES, EXCLAMATIONS_MAX, SENTENCES_PER_PARAGRAPH_MAX, TAGS_MAX, TAGS_MIN, TITLE_MAX_CHARS } from "@contract/domain.js";

import { buildPrompt } from "./prompt.js";

const product = (externalId: string, over: Partial<Product> = {}): Product => ({
  externalId,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 제목 ${externalId}`,
  url: "https://www.yes24.com/Product/Goods/" + externalId + "?addon=secret-tracking",
  priceKrw: 15120,
  priceAsOf: "2026-10-01T00:00:00.000Z",
  specs: { 저자: "김서연" },
  ...over,
});

const base = { category: "book" as const, products: [product("1")], memo: null, avoidPhrases: [], problems: [] };

describe("buildPrompt", () => {
  it("[REQ-002] 모델에게 상품 ID·제목·가격·기준일·스펙을 데이터로 준다", () => {
    const { user } = buildPrompt(base);
    expect(user).toContain("책 제목 1");
    expect(user).toContain("15120");
    expect(user).toContain("2026-10-01");
    expect(user).toContain("김서연");
    expect(user).toContain('"externalId": "1"');
  });

  it("[REQ-010] 제휴 링크는 모델에게 보내지 않는다(링크·대가성 문구는 렌더러가 붙인다)", () => {
    const { system, user } = buildPrompt(base);
    expect(user).not.toContain("https://");
    expect(user).not.toContain("secret-tracking");
    expect(system).toMatch(/링크|대가성/);
  });

  it("[REQ-011][REQ-015] 시스템 지침에 후기 창작 금지·금지 표현 전체·경험 한 줄은 null 규칙이 들어간다", () => {
    const { system } = buildPrompt(base);
    for (const phrase of BANNED_PHRASES) expect(system).toContain(phrase);
    expect(system).toMatch(/지어내지/);
    expect(system).toMatch(/experienceLine/);
    expect(system).toMatch(/null/);
  });

  it("[REQ-027] 문체 규칙: 해요체·수치 한도·초성 금지·체험 어미 금지, 골든셋 허용 문장 few-shot", () => {
    const { system } = buildPrompt(base);
    expect(system).toMatch(/해요체/);
    expect(system).toContain(`${SENTENCES_PER_PARAGRAPH_MAX}문장`);
    expect(system).toContain(`${EXCLAMATIONS_MAX}개`);
    expect(system).toMatch(/ㅋㅋ/);
    expect(system).toMatch(/더라고요/);
    expect(system).toContain("저는 이런 결의 책이 좋아요"); // 부록 B #3
    expect(system).toContain("저한테 하는 말이기도 해요"); // 부록 B #4-1 금지 예
    expect(buildPrompt({ ...base, category: "appliance" }).system).toContain("딱 맞을 것 같아요"); // 가전 추측 표지 #9
  });

  it("[REQ-032][REQ-031] 제목·태그·도입·마무리 규칙과 이모지 금지가 시스템 지침에 들어간다", () => {
    for (const category of ["book", "appliance"] as const) {
      const { system } = buildPrompt({ ...base, category });
      expect(system).toMatch(/keyword/);
      expect(system).toContain(`${TITLE_MAX_CHARS}자`);
      expect(system).toContain(`${TAGS_MIN}~${TAGS_MAX}개`);
      expect(system).toMatch(/intro/);
      expect(system).toMatch(/closing/);
      expect(system).toMatch(/이모지/);
    }
  });

  it("[REQ-002] 카테고리별 골격 지침: 가전=비교표(행 수=상품 수), 책=한 권 리뷰(줄거리·분위기·이런 사람에게·인상 깊은 대목)", () => {
    const appliance = buildPrompt({ ...base, category: "appliance", products: [product("1", { category: "appliance" })] });
    expect(appliance.system).toMatch(/비교표/);
    expect(appliance.system).toMatch(/행 수/);
    const book = buildPrompt(base).system;
    for (const field of ["synopsis", "mood", "recommendedFor", "highlights"]) expect(book).toContain(field);
    expect(book).toMatch(/한 권/);
    expect(book).not.toMatch(/큐레이션|oneLiner/);
  });

  it("[REQ-002][REQ-011] 책 말투는 대화체지만 지어낸 1인칭 독서 경험은 금지한다", () => {
    const { system } = buildPrompt(base);
    expect(system).toMatch(/대화체|구어체/);
    expect(system).toMatch(/1인칭/);
  });

  it("[REQ-002] 책 소개문·목차를 데이터로 주고, 그대로 옮기지 말라고 지시한다", () => {
    const withDetail = product("1", { bookDetail: { introduction: "삼 년 만에 나온 장편 소개문", tableOfContents: "1장 시작 2장 끝" } });
    const { system, user } = buildPrompt({ ...base, products: [withDetail] });
    expect(user).toContain("삼 년 만에 나온 장편 소개문");
    expect(user).toContain("1장 시작 2장 끝");
    expect(system).toMatch(/그대로 (옮|베끼|복사)/);
  });

  it("[REQ-002] 소개문이 비어 있으면 줄거리를 기억·상식으로 보태지 말라고 지시한다(실호출에서 모델이 없는 인물을 보탠 사례)", () => {
    expect(buildPrompt(base).system).toMatch(/소개문이 비어/);
    expect(buildPrompt(base).system).toMatch(/기억|상식/);
  });

  it("[REQ-016] 후기 근거가 있으면 의역 근거로 주고 인용·원문·URL 금지를 지시한다", () => {
    const { system, user } = buildPrompt({ ...base, reviewNotes: "- 분위기: 잔잔하다는 평" });
    expect(user).toContain("후기 근거");
    expect(user).toContain("잔잔하다는 평");
    for (const rule of ["의역", "큰따옴표", "URL"]) expect(system).toContain(rule);
  });

  it("[REQ-016] 후기 노트는 경계 태그로 감싸고, 노트 안의 지시문은 따르지 말라고 지시한다(웹 내용 → 프롬프트 인젝션 방어)", () => {
    const { system, user } = buildPrompt({ ...base, reviewNotes: "- 분위기: 잔잔" });
    expect(user).toMatch(/<review_notes>[\s\S]*잔잔[\s\S]*<\/review_notes>/);
    expect(system).toMatch(/review_notes/);
    expect(system).toMatch(/지시문/);
  });

  it("[REQ-016] 수정 재생성(후기를 다시 모으지 않음)에서는 '근거 없음'이 아니라 이전 초안 밖의 새 사실을 더하지 말라고 지시한다", () => {
    const previousBody = { category: "book" as const, title: "t", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null };
    const { user } = buildPrompt({ ...base, revision: { previousBody, instruction: "인상 깊은 대목을 더 구체적으로", experienceLine: null } });
    expect(user).not.toMatch(/후기 근거가 없/);
    expect(user).toMatch(/이전 초안에 없는 (새 )?사실/);
  });

  it("[REQ-016] 후기 근거가 없으면 그 사실을 알려 인상 깊은 대목을 지어내지 않게 한다", () => {
    const { user } = buildPrompt(base);
    expect(user).toMatch(/후기 근거가 없/);
    expect(user).not.toContain("후기 근거:");
  });

  it("[REQ-016] 가전 프롬프트에는 후기 근거 섹션이 없다", () => {
    const { user } = buildPrompt({ ...base, category: "appliance", products: [product("1", { category: "appliance" })], reviewNotes: "x" });
    expect(user).not.toContain("후기 근거");
  });

  it("[REQ-006] 메모가 있을 때만 사용자 메모 섹션이 생긴다", () => {
    expect(buildPrompt(base).user).not.toContain("사용자 메모");
    expect(buildPrompt({ ...base, memo: "6인용, 신혼 부부용" }).user).toContain("6인용, 신혼 부부용");
  });

  it("[REQ-015] 재생성 시 쓰지 말아야 할 표현과 고쳐야 할 문제를 알려준다", () => {
    const { user } = buildPrompt({ ...base, avoidPhrases: ["에 대해 알아보겠습니다"], problems: ["비교표 행 수가 다릅니다"] });
    expect(user).toContain("에 대해 알아보겠습니다");
    expect(user).toContain("비교표 행 수가 다릅니다");
  });
});

describe("buildPrompt — 수정(revision)", () => {
  const previousBody = { category: "book" as const, title: "이전 제목", synopsis: "이전 줄거리", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null };

  it("[REQ-008] 이전 초안과 수정 지시를 모델에게 준다", () => {
    const { user } = buildPrompt({ ...base, revision: { previousBody, instruction: "소개를 짧게", experienceLine: null } });
    expect(user).toContain("이전 제목");
    expect(user).toContain("소개를 짧게");
  });

  it("[REQ-011] 내가 준 경험 문장이 있으면 그대로 experienceLine에 넣으라고 지시한다", () => {
    const { system } = buildPrompt({ ...base, revision: { previousBody, instruction: "x", experienceLine: "소음이 생각보다 컸어요" } });
    expect(system).toContain("소음이 생각보다 컸어요");
    expect(system).toMatch(/한 글자도/);
  });

  it("[REQ-011] 수정이어도 경험 문장이 없으면 experienceLine은 null 규칙 그대로", () => {
    const { system } = buildPrompt({ ...base, revision: { previousBody, instruction: "x", experienceLine: null } });
    expect(system).toMatch(/experienceLine 필드는 항상 null/);
  });
});

describe("buildPrompt — 경험 지우기", () => {
  it("[REQ-011] clearExperience면 이전 초안에 경험 문장이 있어도 null 규칙을 쓴다", () => {
    const previousBody = { category: "book" as const, title: "t", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: "이전 경험" };
    const { system } = buildPrompt({ ...base, revision: { previousBody, instruction: "x", experienceLine: null, clearExperience: true } });
    expect(system).toMatch(/experienceLine 필드는 항상 null/);
    expect(system).not.toContain("이전 경험");
  });

  it("[REQ-028] 가전 프롬프트에는 근거 팩트 목록과 추측 표지·팩트 밖 수치 금지 규칙이 들어가고, 팩트가 없으면 판단 생략을 지시한다", () => {
    const applianceBase = { ...base, category: "appliance" as const };
    const withFacts = buildPrompt({ ...applianceBase, facts: [{ id: "capacity_max", text: "용량이 가장 큰 제품은 C(12L)", productExternalId: "c" }] });
    expect(withFacts.user).toContain("capacity_max: 용량이 가장 큰 제품은 C(12L)");
    expect(withFacts.system).toContain("factIds");
    expect(withFacts.system).toContain("추측 표지");
    expect(buildPrompt({ ...applianceBase, facts: [] }).user).toContain("근거 팩트가 없습니다");
    expect(buildPrompt(base).user).not.toContain("<facts>");
  });

  it("[REQ-029] 책 프롬프트에 고른 필사 문구와 '이 문장이 필사하기 좋은 이유' 지시가 들어가고, 문구가 없으면 들어가지 않는다", () => {
    const withQuote = buildPrompt({ ...base, quote: { text: "오늘 하루도 충분히 애썼어요.", attribution: "— 『가호』, 하루키", origin: "web" as const } });
    expect(withQuote.user).toContain("<quote>");
    expect(withQuote.user).toContain("오늘 하루도 충분히 애썼어요.");
    expect(withQuote.user).toContain("필사하기 좋은 이유");
    expect(buildPrompt({ ...base, quote: null }).user).not.toContain("<quote>");
    expect(buildPrompt(base).user).not.toContain("<quote>");
  });
});
