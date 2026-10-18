// 1.5 관통: 실제 렌더러 + Playwright 드라이버 + 퍼블리셔로 임시저장 1건. 발행은 하지 않는다.
import type { Draft } from "../../docs/contract/domain.js";
import { createNaverDraftPublisher } from "../../src/publish/naver.js";
import { createPlaywrightNaverDriver } from "../../src/publish/naver-playwright.js";

const draft: Draft = {
  id: 999, category: "book", mode: "daily", status: "awaiting_approval", memo: null, quality: null,
  products: [{ externalId: "1", source: "yes24", category: "book", affiliate: "yes24", title: "테스트 책", url: "https://www.yes24.com/addon/1?a=1&b=2", priceKrw: 15120, priceAsOf: "2026-10-17T15:00:00.000Z", specs: {} }],
  body: { category: "book", title: "[돌쇠 관통] 어댑터 임시저장 테스트 — 지워도 되는 글", synopsis: "줄거리 문단이에요", mood: "분위기 문단이에요", recommendedFor: "이런 사람 문단이에요", highlights: "인상 깊은 대목 문단이에요", experienceLine: "출퇴근길에 읽었어요" },
  createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z",
};
const publisher = createNaverDraftPublisher({ driver: createPlaywrightNaverDriver({ profileDir: "data/naver-profile" }) });
const result = await publisher.publish({ draftId: draft.id, title: draft.body!.title, content: publisher.render(draft) });
console.log(JSON.stringify(result));
