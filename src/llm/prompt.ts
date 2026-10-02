import { BANNED_PHRASES } from "@contract/domain.js";

import type { GenerateBodyInput } from "../draft/generate.js";

const COMMON_RULES = `당신은 한국어 제휴 블로그의 초안 작성자입니다. 아래 규칙을 반드시 지킵니다.

1. 제공된 상품 데이터(제목·가격·기준일·스펙)에 있는 사실만 씁니다. 없는 스펙·성능·수상·리뷰를 지어내지 않습니다.
2. 직접 써봤다/읽어봤다는 식의 후기·경험을 지어내지 않습니다. 이 글에는 작성자의 사용 경험이 없습니다.
3. experienceLine 필드는 항상 null로 둡니다. 경험 문장은 사람이 따로 넣습니다.
4. 가격은 단정하지 말고 "기준일 기준 약 N원"처럼 기준일을 밝혀 씁니다. 재고·할인 여부는 말하지 않습니다.
5. productExternalId에는 제공된 externalId만 씁니다. 없는 ID를 만들지 않습니다.
6. 구매 링크와 제휴 대가성 문구는 시스템이 자동으로 붙이므로 본문에 쓰지 않습니다. URL도 쓰지 않습니다.
7. 다음 표현은 쓰지 않습니다: ${BANNED_PHRASES.map((phrase) => `"${phrase}"`).join(", ")}. 상투적인 도입부·맺음말 없이 바로 핵심을 씁니다.
8. 한국어 존댓말, 간결하고 구체적으로 씁니다.`;

const APPLIANCE_RULES = `
[글 종류: 생활가전·주방 비교표형]
- title: 상품군과 개수가 드러나는 제목(예: "20평대 공기청정기 3종 비교").
- verdict: 한 줄 결론.
- comparison: 비교표. 비교표의 행 수는 제공된 상품 수와 같아야 하고, 각 행의 열 수는 headers의 수와 같아야 합니다. 첫 열은 제품명입니다. 데이터에 있는 항목(가격 등)만 열로 씁니다.
- recommendations: "이런 분께 이 제품" 형태. forWhom(누구에게), productExternalId, reason(데이터에 근거한 이유).`;

const BOOK_RULES = `
[글 종류: 책 큐레이션형]
- title: 주제와 권수가 드러나는 제목(예: "이번 주 베스트셀러 5권").
- intro: 어떤 기준으로 고른 목록인지 한두 문장.
- items: 제공된 책을 한 번씩, 모두 소개합니다. 같은 책을 두 번 쓰거나 빠뜨리지 않습니다. 책마다 oneLiner(한 줄 소개)와 reason(추천 이유)을 쓰고, 줄거리를 길게 옮겨 적지 않습니다.`;

export function buildPrompt(input: GenerateBodyInput): { system: string; user: string } {
  const system = COMMON_RULES + (input.category === "appliance" ? APPLIANCE_RULES : BOOK_RULES);

  // 모델에는 제휴 링크(url)를 보내지 않는다 — 링크는 렌더러가 붙인다(REQ-010).
  const products = input.products.map((product) => ({
    externalId: product.externalId,
    title: product.title,
    priceKrw: product.priceKrw,
    priceAsOf: product.priceAsOf,
    specs: product.specs,
  }));

  const sections = [`상품 데이터(${input.products.length}개):\n${JSON.stringify(products, null, 2)}`];
  if (input.memo !== null) sections.push(`사용자 메모(글에 반영할 조건):\n${input.memo}`);
  if (input.avoidPhrases.length > 0) {
    sections.push(`직전 초안에 아래 표현이 쓰였습니다. 다시 쓰지 마세요:\n${input.avoidPhrases.map((p) => `- ${p}`).join("\n")}`);
  }
  if (input.problems.length > 0) {
    sections.push(`직전 초안의 문제입니다. 모두 고쳐서 다시 작성하세요:\n${input.problems.map((p) => `- ${p}`).join("\n")}`);
  }
  return { system, user: sections.join("\n\n") };
}
