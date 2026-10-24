import { describe, expect, it } from "vitest";

import type { ApplianceBody, BookBody, Product } from "@contract/domain.js";
import { EXCLAMATIONS_MAX, SENTENCES_PER_PARAGRAPH_MAX } from "@contract/domain.js";

import { checkQuality, findCopyProblems, findExperienceClaims, validateAgainstProducts } from "./quality-check.js";

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

const appliance = (over: Partial<ApplianceBody> = {}): ApplianceBody => ({
  category: "appliance",
  title: "20평대 공기청정기 3종 비교",
  verdict: "가성비는 A, 정숙성은 B",
  comparison: {
    headers: ["제품", "가격"],
    rows: [
      ["제품 1", "10만원"],
      ["제품 2", "20만원"],
    ],
  },
  recommendations: [{ forWhom: "원룸", productExternalId: "1", reason: "작고 저렴" }],
  experienceLine: null,
  ...over,
});

const book = (over: Partial<BookBody> = {}): BookBody => ({
  category: "book",
  title: "하루키의 새 장편",
  synopsis: "한 남자가 오래된 기억을 따라가는 이야기예요.",
  mood: "잔잔하고 쓸쓸한 분위기라 조용한 밤에 어울려요.",
  recommendedFor: "천천히 읽는 소설을 좋아하는 분께 맞아요.",
  highlights: "후기마다 마지막 장면의 여운을 이야기해요.",
  experienceLine: null,
  ...over,
});

describe("checkQuality", () => {
  it("[REQ-015] 봇이 만든 문장에 금지 표현이 있으면 찾아서 중복 없이 알려준다", () => {
    const report = checkQuality(
      appliance({ verdict: "이 제품에 대해 알아보겠습니다", title: "에 대해 알아보겠습니다 비교" }),
    );
    expect(report.bannedPhrasesFound).toEqual(["에 대해 알아보겠습니다"]);
  });

  it("[REQ-015] 표 셀·추천 이유·책 한 줄 소개 같은 중첩 필드도 검사한다", () => {
    const a = checkQuality(appliance({ comparison: { headers: ["a", "b"], rows: [["써봤더니 좋음", "x"]] } }));
    expect(a.bannedPhrasesFound).toContain("써봤더니");
    const b = checkQuality(book({ mood: "직접 써보니" }));
    expect(b.bannedPhrasesFound).toContain("직접 써보니");
  });

  it("[REQ-015][REQ-011] 사용자가 준 경험 문장은 금지 표현 검사에서 제외한다", () => {
    const report = checkQuality(appliance({ experienceLine: "써봤더니 소음이 컸어요" }));
    expect(report.bannedPhrasesFound).toEqual([]);
    expect(report.hasExperienceLine).toBe(true);
  });

  it("[REQ-015] 경험 한 줄 유무: 문장이 있으면 true, null이나 공백뿐이면 false", () => {
    expect(checkQuality(appliance({ experienceLine: "소음이 컸어요" })).hasExperienceLine).toBe(true);
    expect(checkQuality(appliance({ experienceLine: null })).hasExperienceLine).toBe(false);
    expect(checkQuality(appliance({ experienceLine: "   " })).hasExperienceLine).toBe(false);
  });

  it("[REQ-015] 깨끗한 초안은 금지 표현 0개", () => {
    expect(checkQuality(book()).bannedPhrasesFound).toEqual([]);
  });
});

describe("validateAgainstProducts", () => {
  it("[REQ-002] 골격이 맞으면(표 행 수=상품 수, 추천이 실제 상품을 가리킴) 문제가 없다", () => {
    expect(validateAgainstProducts(appliance(), [product("1"), product("2")])).toEqual([]);
    expect(validateAgainstProducts(book(), [product("1")])).toEqual([]);
  });

  it("[REQ-002] 모델이 만든 상품 ID(없는 상품)를 참조하면 문제로 잡는다", () => {
    const problems = validateAgainstProducts(
      appliance({ recommendations: [{ forWhom: "x", productExternalId: "999", reason: "r" }] }),
      [product("1"), product("2")],
    );
    expect(problems.join(" ")).toMatch(/999/);
  });

  it("[REQ-002] 비교표 행 수가 상품 수와 다르거나 열 수가 머리글과 다르면 문제로 잡는다", () => {
    const wrongRows = validateAgainstProducts(
      appliance({ comparison: { headers: ["a", "b"], rows: [["1", "2"]] } }),
      [product("1"), product("2")],
    );
    expect(wrongRows.length).toBeGreaterThan(0);
    const wrongCols = validateAgainstProducts(
      appliance({ comparison: { headers: ["a", "b"], rows: [["1"], ["2", "3"]] } }),
      [product("1"), product("2")],
    );
    expect(wrongCols.length).toBeGreaterThan(0);
  });
});

describe("findCopyProblems", () => {
  const INTRO = "무라카미 하루키가 삼 년 만에 내놓은 장편으로 좋은 이야기란 무엇인가라는 질문에 답을 담았다";
  const TOC = "1장 가호와 모터사이클 남자 2장 무사시사카이의 개미핥기 3장 가호와 흰개미 여왕";
  const withDetail = (title = "가호"): Product => ({
    ...product("1"),
    category: "book",
    source: "yes24",
    affiliate: "yes24",
    title,
    bookDetail: { introduction: INTRO, tableOfContents: TOC },
  });

  it("[REQ-016] 직접 인용(큰따옴표)이 있으면 문제로 잡는다", () => {
    const problems = findCopyProblems(book({ highlights: '한 독자는 "마지막 장면이 오래 남는다"고 했어요.' }), [withDetail()]);
    expect(problems.join(" ")).toMatch(/인용/);
    expect(findCopyProblems(book({ highlights: "독자는 “여운이 길다”고 했어요." }), [withDetail()])).not.toEqual([]);
  });

  it("[REQ-016] 출처 URL이 본문에 들어가면 문제로 잡는다(출처는 DB에만)", () => {
    const problems = findCopyProblems(book({ mood: "자세한 후기는 https://blog.example.com/review 에 있어요" }), [withDetail()]);
    expect(problems.join(" ")).toMatch(/URL/);
  });

  it("[REQ-016] 소개문을 20자 이상 그대로 옮기면 문제로 잡는다(공백 차이는 무시)", () => {
    const copied = "삼 년 만에 내놓은 장편으로  좋은 이야기란 무엇인가라는 질문";
    const problems = findCopyProblems(book({ synopsis: `이 책은 ${copied}에 답해요.` }), [withDetail()]);
    expect(problems.join(" ")).toMatch(/소개문/);
  });

  it("[REQ-016] 목차 문장을 그대로 옮겨도 잡고, 짧게 겹치는 정도는 통과시킨다", () => {
    expect(findCopyProblems(book({ highlights: "1장 가호와 모터사이클 남자 2장 무사시사카이의 개미핥기 같은 장 제목이 재밌어요" }), [withDetail()]).join(" ")).toMatch(/목차/);
    expect(findCopyProblems(book({ highlights: "흰개미 여왕 장면이 인상적이에요" }), [withDetail()])).toEqual([]);
  });

  it("[REQ-016] 책 제목처럼 원래 길게 겹치는 고유명은 복사로 보지 않는다", () => {
    const longTitle = "무라카미 하루키가 삼 년 만에 내놓은 장편";
    const problems = findCopyProblems(book({ title: longTitle, synopsis: "제목 그대로의 책이에요" }), [withDetail(longTitle)]);
    expect(problems).toEqual([]);
  });

  it("[REQ-016] 후기 원문 조각(인용된 cited_text)을 20자 이상 그대로 옮기면 문제로 잡는다", () => {
    const excerpt = "깨달음은 가르칠 수 없고 직접 체험으로만 알 수 있다";
    const copied = book({ highlights: "독자들은 깨달음은 가르칠 수  없고 직접 체험으로만 알 수 있다고 해요." });
    expect(findCopyProblems(copied, [withDetail()], [excerpt]).join(" ")).toMatch(/후기 원문/);
    expect(findCopyProblems(copied, [withDetail()])).toEqual([]); // 대조 자료가 없으면 이 검사는 건너뛴다
    expect(findCopyProblems(book({ highlights: "깨달음은 직접 겪어야 안다는 얘기가 많아요" }), [withDetail()], [excerpt])).toEqual([]);
  });

  it("[REQ-016] 의역한 깨끗한 초안·소개문 정보가 없는 상품은 문제가 없다", () => {
    expect(findCopyProblems(book(), [withDetail()])).toEqual([]);
    expect(findCopyProblems(book(), [product("1")])).toEqual([]);
  });

  it("[REQ-016][REQ-011] 사용자가 준 경험 문장은 검사에서 제외한다", () => {
    const experience = `"여운이 길었다" 삼 년 만에 내놓은 장편으로 좋은 이야기란 무엇인가라는 질문`;
    expect(findCopyProblems(book({ experienceLine: experience }), [withDetail()])).toEqual([]);
  });
});

describe("findExperienceClaims", () => {
  it("[REQ-011] 봇이 지어낸 후기·경험 표현(변형 포함)을 찾는다", () => {
    for (const phrase of ["써보니 조용했어요", "직접 사용해 봤는데", "제가 읽어보니", "몇 달간 사용했습니다"]) {
      expect(findExperienceClaims(appliance({ verdict: phrase }))).not.toEqual([]);
    }
  });

  it("[REQ-011] 데이터 기반 서술은 걸리지 않는다", () => {
    expect(findExperienceClaims(appliance({ verdict: "가격 대비 필터 비용이 낮습니다" }))).toEqual([]);
  });

  it("[REQ-011] 사용자가 준 경험 문장(experienceLine)은 검사 대상이 아니다", () => {
    expect(findExperienceClaims(appliance({ experienceLine: "직접 써보니 소음이 컸어요" }))).toEqual([]);
  });
});

describe("checkQuality 문체 점검 (부록 B 골든셋)", () => {
  const styleOf = (sentence: string, category: "book" | "appliance" = "book"): string[] =>
    (category === "book" ? checkQuality(book({ mood: sentence })) : checkQuality(appliance({ verdict: sentence }))).styleIssues ?? [];

  it.each([
    ["#1", "하루가 길었던 날엔 긴 책보다 짧은 문장이 필요한 것 같아요", "book"],
    ["#2", "후기를 보면 잔잔한데 은근히 위로가 된다는 반응이 많은 것 같아요", "book"],
    ["#3", "저는 이런 결의 책이 좋아요", "book"],
    ["#4", "이런 책 한 권 옆에 두면 마음이 좀 놓일 것 같아요", "book"],
    ["#8", "리터당 10,750원인 C가 가장 앞서요", "appliance"],
    ["#9", "1인가구라면 A(3.5L)가 딱 맞을 것 같아요", "appliance"],
    ["#10", "저라면 식구가 많은 집엔 C를 먼저 권하고 싶어요", "appliance"],
  ] as const)("[REQ-030] 허용 %s 문장은 문체 위반 0개: %s", (_id, sentence, category) => {
    expect(styleOf(sentence, category)).toEqual([]);
  });

  it.each([
    ["#4-1a", "저한테 하는 말이기도 해요", "book"],
    ["#4-1b", "이 대목이 와닿았어요", "book"],
    ["#4-1c", "울컥했어요", "book"],
    ["#5", "퇴근길에 이 책을 펼쳤는데 눈물이 났어요", "book"],
    ["#6", "주말 아침에 커피 옆에 두고 펼쳤어요", "book"],
    ["#11", "저희집이 좁은데도 쏙 들어가더라구요", "appliance"],
    ["#12a", "소음이 작아요", "appliance"],
    ["#12b", "오래 써도 튼튼해요", "appliance"],
    ["#13", "3주 썼는데 배터리가 6시간 갔어요", "appliance"],
  ] as const)("[REQ-030] 금지 %s 문장은 문체 위반 1개 이상: %s", (_id, sentence, category) => {
    expect(styleOf(sentence, category).length).toBeGreaterThan(0);
  });

  it("[REQ-030] #14 사용자 메모(experienceLine) 원문은 검사에서 제외한다", () => {
    expect(checkQuality(book({ experienceLine: "출퇴근길에 읽었어요, 써봤더니 소음이 컸어요" })).styleIssues).toEqual([]);
  });

  it("[REQ-027] 느낌표가 글당 상한을 넘으면 위반", () => {
    const ok = "!".repeat(EXCLAMATIONS_MAX);
    expect(styleOf(`좋아요${ok}`)).toEqual([]);
    expect(styleOf(`좋아요${ok}!`).join(" ")).toMatch(/느낌표/);
  });

  it("[REQ-027] 한 문단이 문장 상한을 넘으면 위반(문단 = 필드 값·줄바꿈 단위)", () => {
    const sentences = (n: number): string => Array.from({ length: n }, (_, i) => `문장 ${i}이에요.`).join(" ");
    expect(styleOf(sentences(SENTENCES_PER_PARAGRAPH_MAX))).toEqual([]);
    expect(styleOf(sentences(SENTENCES_PER_PARAGRAPH_MAX + 1)).join(" ")).toMatch(/문단/);
    expect(styleOf(`${sentences(SENTENCES_PER_PARAGRAPH_MAX)}\n${sentences(SENTENCES_PER_PARAGRAPH_MAX)}`)).toEqual([]);
  });

  it("[REQ-027] 초성 표현(ㅋㅋ·ㅠㅠ)은 위반", () => {
    expect(styleOf("재밌어요 ㅋㅋ").join(" ")).toMatch(/초성/);
    expect(styleOf("슬퍼요 ㅠㅠ").join(" ")).toMatch(/초성/);
  });

  it("[REQ-030] quote.text는 trustedQuote와 글자 그대로 같을 때만 검사 제외, 다르면 검사한다", () => {
    const quoted = book({ quote: { text: "울컥했던 그날의 기록", attribution: "— 『책』, 저자", origin: "web" } });
    expect(checkQuality(quoted, { trustedQuote: "울컥했던 그날의 기록" }).styleIssues).toEqual([]);
    expect(checkQuality(quoted, { trustedQuote: "다른 문장" }).styleIssues?.length).toBeGreaterThan(0);
    expect(checkQuality(quoted).styleIssues?.length).toBeGreaterThan(0);
  });
});
