// 1.7b 관통: 새 양식(renderNaverHtml)으로 책·가전 샘플 2건을 실제 임시저장함에 저장한다. 발행은 하지 않는다. 저장된 글은 사람이 눈으로 확인하고 지운다.
import "dotenv/config";
import type { Draft, Product } from "../../docs/contract/domain.js";
import { requiredDisclosures } from "../../src/publish/disclosure.js";
import { createNaverDraftPublisher } from "../../src/publish/naver.js";
import { createPlaywrightNaverDriver } from "../../src/publish/naver-playwright.js";

const base = { mode: "daily", status: "awaiting_approval", memo: null, quality: null, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" } as const;
const book: Product = { externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "테스트 에세이", url: "https://www.yes24.com/addon/1?a=1&b=2", priceKrw: 15120, priceAsOf: "2026-10-23T15:00:00.000Z", specs: {} };
const fans = ["A 에어프라이어", "B 에어프라이어", "C 에어프라이어"].map((title, i): Product => ({ externalId: `a${i}`, source: "coupang_link", category: "appliance", affiliate: "coupang", title, url: `https://link.coupang.com/a/test${i}`, priceKrw: 89000 + i * 20000, priceAsOf: "2026-10-23T15:00:00.000Z", specs: {} }));

const drafts: Draft[] = [
  { ...base, id: 901, category: "book", products: [book], body: { category: "book", title: "[돌쇠 양식 확인] 테스트 에세이 추천", keyword: "테스트 에세이", intro: "하루가 길었던 날엔 짧은 문장이 필요한 것 같아요", synopsis: "한 사람이 일상의 작은 순간들을 따라가는 이야기예요. 문장이 짧고 담백해요.", mood: "잔잔하고 조용해요. 밤에 천천히 읽기 좋은 분위기라고들 해요.", recommendedFor: "바쁜 하루 끝에 숨 돌릴 책을 찾는 분께 맞아요. 짧게 끊어 읽기 좋아요.", highlights: "목차에서 일상의 순간별로 장이 나뉘는 구성이 눈에 띄어요.", closing: "오늘 밤 한 권 곁에 두면 어떨까요", tags: ["테스트에세이", "에세이추천", "책추천", "잔잔한책"], experienceLine: "출퇴근길에 읽었어요" } },
  { ...base, id: 902, category: "appliance", products: fans, body: { category: "appliance", title: "[돌쇠 양식 확인] 에어프라이어 3종 비교", keyword: "에어프라이어", intro: "에어프라이어 고르기 어려우셨죠. 가격과 용량으로 간단히 비교했어요.", verdict: "가격은 A, 용량은 C가 앞서요", comparison: { headers: ["제품", "가격", "용량"], rows: [["A 에어프라이어", "89,000원", "3.5L"], ["B 에어프라이어", "109,000원", "5L"], ["C 에어프라이어", "129,000원", "8L"]] }, recommendations: [{ forWhom: "1인가구", productExternalId: "a0", reason: "3.5L라 딱 맞을 것 같아요" }, { forWhom: "식구 많은 집", productExternalId: "a2", reason: "8L로 한 번에 많이 돌릴 수 있어요" }], closing: "취향에 맞는 한 대를 골라 보세요", tags: ["에어프라이어", "에어프라이어추천", "주방가전", "비교"], experienceLine: null } },
];
const publisher = createNaverDraftPublisher({ driver: createPlaywrightNaverDriver({ profileDir: process.env.NAVER_PROFILE_DIR ?? "data/naver-profile" }) });
for (const draft of drafts) {
  const result = await publisher.publish({ draftId: draft.id, title: draft.body!.title, content: publisher.render(draft), mustContain: requiredDisclosures(draft.products) });
  console.log(draft.id, JSON.stringify(result));
}
