import { describe, expect, it, vi } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

import { missingDisclosures } from "./disclosure.js";
import { createNaverDraftPublisher, missingTexts, renderNaverHtml, type NaverEditorDriver } from "./naver.js";

const product = (id: string, over: Partial<Product> = {}): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}?a=1&b=2`,
  priceKrw: 15120,
  priceAsOf: "2026-10-01T15:00:00.000Z",
  specs: {},
  ...over,
});

const bookBody = (over: Partial<Extract<DraftBody, { category: "book" }>> = {}): DraftBody => ({
  category: "book",
  title: "퇴근 후 읽기 좋은 에세이 한 권",
  synopsis: "줄거리 문단이에요",
  mood: "분위기 문단이에요",
  recommendedFor: "이런 사람 문단이에요",
  highlights: "인상 깊은 대목 문단이에요",
  experienceLine: null,
  ...over,
});

const applianceBody = (): DraftBody => ({
  category: "appliance",
  title: "청소기 2종 비교",
  verdict: "가성비는 A <b>",
  comparison: { headers: ["제품", "가격"], rows: [["청소기 A", "30만원"], ["청소기 B", "50만원"]] },
  recommendations: [{ forWhom: "원룸", productExternalId: "a", reason: "작고 가벼움" }],
  experienceLine: null,
});

const draft = (body: DraftBody, products: Product[]): Draft => ({
  id: 7,
  category: body.category,
  mode: "daily",
  status: "awaiting_approval",
  products,
  body,
  memo: null,
  quality: null,
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});

describe("renderNaverHtml — 네이버 에디터에 붙여넣을 HTML", () => {
  it("[REQ-012] 책 글은 섹션 소제목과 문단, 구매 링크가 HTML로 들어간다(제목은 본문에 넣지 않는다)", () => {
    const html = renderNaverHtml(draft(bookBody(), [product("1")]));
    expect(html).toContain("<h3>줄거리</h3>");
    expect(html).toContain("<p>줄거리 문단이에요</p>");
    expect(html).toContain("<h3>이런 사람에게</h3>");
    expect(html).toContain("<h3>구매 링크</h3>");
    expect(html).toContain('<a href="https://www.yes24.com/addon/1?a=1&amp;b=2">책 1</a>');
    expect(html).not.toContain("퇴근 후 읽기 좋은 에세이 한 권");
  });

  it("[REQ-012] 가전 글은 비교표가 <table>로 들어가고 본문 텍스트는 이스케이프된다", () => {
    const html = renderNaverHtml(draft(applianceBody(), [product("a", { category: "appliance", source: "coupang_link", affiliate: "coupang" })]));
    expect(html).toContain("<table");
    expect(html).toContain("<th>제품</th>");
    expect(html).toContain("<td>청소기 B</td>");
    expect(html).toContain("가성비는 A &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("[REQ-010] 대가성 문구가 HTML에도 그대로 들어가 공통 게이트를 통과한다", () => {
    const d = draft(bookBody(), [product("1")]);
    const html = renderNaverHtml(d);
    expect(html).toContain(DISCLOSURE_TEXTS.yes24);
    expect(missingDisclosures(html, d.products)).toEqual([]);
  });

  it("[REQ-011] 경험 한 줄은 있을 때만 문단으로 들어가고, 가격엔 기준일이 붙는다", () => {
    const without = renderNaverHtml(draft(bookBody(), [product("1")]));
    expect(without).not.toContain("내 경험");
    const withLine = renderNaverHtml(draft(bookBody({ experienceLine: "출퇴근길에 읽었어요" }), [product("1")]));
    expect(withLine).toContain("<h3>내 경험</h3>");
    expect(withLine).toContain("<p>출퇴근길에 읽었어요</p>");
    expect(withLine).toContain("10/02 기준");
  });
});

const fakeDriver = (result: Awaited<ReturnType<NaverEditorDriver["saveDraft"]>> | Error) => {
  const saveDraft = vi.fn<NaverEditorDriver["saveDraft"]>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { saveDraft };
};

describe("createNaverDraftPublisher — 임시저장 어댑터", () => {
  const post = { draftId: 7, title: "제목", content: "<p>본문</p>", mustContain: ["대가성 문구"] };

  it("[REQ-012] 임시저장되면 draft 모드 성공을 돌려주고, 드라이버엔 제목과 HTML이 그대로 간다", async () => {
    const driver = fakeDriver({ ok: true });
    const publisher = createNaverDraftPublisher({ driver });
    expect(publisher.mode).toBe("draft");
    await expect(publisher.publish(post)).resolves.toEqual({ ok: true, mode: "draft", url: null, externalId: null });
    expect(driver.saveDraft).toHaveBeenCalledWith({ title: "제목", html: "<p>본문</p>", mustContain: ["대가성 문구"] });
  });

  it("[REQ-013] 로그인 세션이 만료되면 authExpired 실패로 보고한다(재시도 없이 다음 단계로 내려가도록)", async () => {
    const publisher = createNaverDraftPublisher({ driver: fakeDriver({ ok: false, reason: "auth_expired", detail: "로그인 화면" }) });
    await expect(publisher.publish(post)).resolves.toMatchObject({ ok: false, mode: "draft", authExpired: true, retryable: false });
  });

  it("[REQ-013] 에디터를 못 찾으면(저장 전) 사유와 함께 명확한 실패로 보고한다", async () => {
    const publisher = createNaverDraftPublisher({ driver: fakeDriver({ ok: false, reason: "editor_unavailable", detail: "제목 입력칸을 못 찾음" }) });
    const result = await publisher.publish(post);
    expect(result).toMatchObject({ ok: false, mode: "draft", authExpired: false, retryable: false });
    expect(result.ok === false && result.reason).toContain("제목 입력칸을 못 찾음");
  });

  it("[REQ-013] 저장을 눌렀는데 완료를 확인 못 하면 결과 불확실로 던진다 — ④ 폴백으로 중복 글이 생기지 않게 Orchestrator가 멈추도록(ADR-006)", async () => {
    const publisher = createNaverDraftPublisher({ driver: fakeDriver({ ok: false, reason: "save_unconfirmed", detail: "저장 완료를 확인하지 못했어요" }) });
    await expect(publisher.publish(post)).rejects.toThrow("저장 완료를 확인하지 못했어요");
  });

  it("[REQ-013] 드라이버가 던지면 그대로 던진다(결과 불확실 — Orchestrator가 자동 재시도 없이 멈춘다)", async () => {
    const publisher = createNaverDraftPublisher({ driver: fakeDriver(new Error("브라우저가 죽음")) });
    await expect(publisher.publish(post)).rejects.toThrow("브라우저가 죽음");
  });
});

describe("renderNaverHtml — 링크 안전", () => {
  it("[REQ-012] http/https가 아닌 스킴의 URL은 링크로 만들지 않고 제목 텍스트로만 보인다", () => {
    const html = renderNaverHtml(draft(bookBody(), [product("1", { url: "javascript:alert(1)" })]));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("책 1");
  });
});

describe("missingTexts — 에디터 화면에서 반드시 있어야 할 문구 검증", () => {
  it("[REQ-010] 에디터 전체 텍스트에 빠진 문구만 돌려준다(공백·줄바꿈 차이는 무시)", () => {
    const editorText = "제목\n줄거리\n이 포스팅은 YES24 애드온 링크를   포함하며,\n구매 시 수수료를 제공받습니다.";
    expect(missingTexts(editorText, ["이 포스팅은 YES24 애드온 링크를 포함하며, 구매 시 수수료를 제공받습니다."])).toEqual([]);
    expect(missingTexts(editorText, ["없는 문구", "줄거리"])).toEqual(["없는 문구"]);
  });

  it("[REQ-010] 붙여넣기가 중간에 잘려 마지막 문단(대가성 문구)이 빠지면 빠진 것으로 잡는다", () => {
    expect(missingTexts("제목\n줄거리 문단이에요", [DISCLOSURE_TEXTS.yes24])).toEqual([DISCLOSURE_TEXTS.yes24]);
  });
});
