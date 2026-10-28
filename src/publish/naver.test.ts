import { describe, expect, it, vi } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS, EMOJI_MAX_PER_POST } from "@contract/domain.js";

import { missingDisclosures, requiredDisclosures } from "./disclosure.js";
import { APPLIANCE_THEME_ACCENT, BOOK_THEME_ACCENT, HEADING_SIZE_PX, PHOTO_SLOT_MARKER } from "./naver-style.js";
import { createNaverDraftPublisher, isNaverUploadedSrc, missingTexts, renderNaverHtml, splitAtPhotoSlot, type NaverEditorDriver } from "./naver.js";

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
    expect(html).toContain("줄거리 문단이에요");
    expect(html).toContain("이런 사람에게");
    expect(html).toContain("구매 링크");
    expect(html).toContain('<a href="https://www.yes24.com/addon/1?a=1&amp;b=2">책 1</a>');
    expect(html).not.toContain("퇴근 후 읽기 좋은 에세이 한 권");
  });

  it("[REQ-012] 가전 글은 비교표가 <table>로 들어가고 본문 텍스트는 이스케이프된다", () => {
    const html = renderNaverHtml(draft(applianceBody(), [product("a", { category: "appliance", source: "coupang_link", affiliate: "coupang" })]));
    expect(html).toContain("<table");
    expect(html).toContain("청소기 B</span></td>");
    expect(html).toContain("가성비는 A &lt;b&gt;");
    expect(html).not.toContain("가성비는 A <b>");
  });

  it("[REQ-010] 대가성 문구가 HTML에도 그대로 들어가 공통 게이트를 통과한다", () => {
    const d = draft(bookBody(), [product("1")]);
    const html = renderNaverHtml(d);
    expect(html).toContain(DISCLOSURE_TEXTS.yes24);
    expect(missingDisclosures(html, d.products)).toEqual([]);
  });

  it("[REQ-011] 내 한 컷(경험 한 줄)은 있을 때만 코너로 들어가고, 가격엔 기준일이 붙는다", () => {
    const without = renderNaverHtml(draft(bookBody(), [product("1")]));
    expect(without).not.toContain("내 한 컷");
    const withLine = renderNaverHtml(draft(bookBody({ experienceLine: "출퇴근길에 읽었어요" }), [product("1")]));
    expect(withLine).toContain("내 한 컷");
    expect(withLine).toContain("출퇴근길에 읽었어요");
    expect(withLine).toContain("10/02 기준");
  });
});

describe("renderNaverHtml — 카테고리별 양식 (REQ-031)", () => {
  const styled = bookBody({ tags: ["하루키", "소설추천", "책추천"], intro: "하루가 긴 날엔 짧은 문장이 필요해요", closing: "오늘 밤 한 권 어때요", experienceLine: "출퇴근길에 읽었어요" });
  const bookHtml = (id = 7): string => renderNaverHtml({ ...draft(styled, [product("1")]), id });
  const applianceHtml = (id = 7): string =>
    renderNaverHtml({
      ...draft({ ...(applianceBody() as Extract<DraftBody, { category: "appliance" }>), intro: "청소기 고민이에요", closing: "도움이 됐길 바라요", tags: ["청소기", "청소기추천", "주방가전"] }, [
        product("a", { category: "appliance", source: "coupang_link", affiliate: "coupang" }),
      ]),
      id,
    });
  const textOf = (html: string): string => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
  const order = (html: string, parts: string[]): number[] => parts.map((part) => html.indexOf(part));
  const sorted = (xs: number[]): boolean => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

  it("[REQ-031] 책 템플릿 순서: 대가성 문구(위)→도입 인용구→도서 정보 표→줄거리→분위기→이런 사람에게→인상 깊은 대목→내 한 컷→마무리→구매 링크→태그→대가성 문구(아래)", () => {
    const html = bookHtml();
    expect(sorted(order(html, [DISCLOSURE_TEXTS.yes24, "하루가 긴 날엔", "<table", "줄거리 문단이에요", "분위기 문단이에요", "이런 사람 문단이에요", "인상 깊은 대목 문단이에요", "출퇴근길에 읽었어요", "오늘 밤 한 권", "구매 링크", "#하루키"]))).toBe(true);
    expect(html.indexOf("#하루키")).toBeLessThan(html.lastIndexOf(DISCLOSURE_TEXTS.yes24));
    expect(html).toMatch(/<blockquote[^>]*>[\s\S]*하루가 긴 날엔[\s\S]*<\/blockquote>/);
  });

  it("[REQ-031] 도서 정보 표에 제목·저자·가격(기준일 포함)이 들어간다", () => {
    const html = renderNaverHtml({ ...draft(styled, [product("1", { specs: { 저자: "김서연" } })]), id: 7 });
    expect(html).toMatch(/<th[^>]*>[\s\S]*?제목[\s\S]*?저자[\s\S]*?가격/);
    expect(html).toContain("김서연");
  });

  it("[REQ-031] 가전 템플릿 순서: 도입 → 한 줄 결론 콜아웃 → 한눈에 비교 표 → 이런 사람에게 → 총평 → 구매 링크 → 태그 → 대가성 문구", () => {
    const html = applianceHtml();
    expect(html).toMatch(/<td[^>]*background-color[^>]*>[\s\S]*가성비는 A[\s\S]*<\/td>/); // 결론은 색조 콜아웃
    expect(sorted(order(html, ["청소기 고민이에요", "한 줄 결론", "가성비는 A", "한눈에 비교", "<th", "이런 사람에게", "작고 가벼움", "총평", "도움이 됐길", "구매 링크"]))).toBe(true);
    expect(html.indexOf("구매 링크")).toBeLessThan(html.indexOf("#청소기"));
    expect(html.indexOf("#청소기")).toBeLessThan(html.lastIndexOf(DISCLOSURE_TEXTS.coupang));
  });

  it("[REQ-031] 본문은 진회색 16, 소제목은 19~24 크기이고 책=더스티 로즈·가전=딥 틸 테마색이 다르다", () => {
    const book = bookHtml();
    const appliance = applianceHtml();
    expect(book).toMatch(/font-size:16px/);
    expect(book).toMatch(/color:#333333/);
    expect(HEADING_SIZE_PX).toBeGreaterThanOrEqual(19);
    expect(HEADING_SIZE_PX).toBeLessThanOrEqual(24);
    expect(book).toContain(`font-size:${HEADING_SIZE_PX}px`);
    expect(book).toContain(BOOK_THEME_ACCENT);
    expect(book).not.toContain(APPLIANCE_THEME_ACCENT);
    expect(appliance).toContain(APPLIANCE_THEME_ACCENT);
    expect(appliance).not.toContain(BOOK_THEME_ACCENT);
  });

  it("[REQ-031] 형광펜은 글당 3곳 이하이고 표 머리는 옅은 색조·선은 얇은 연회색이다", () => {
    for (const html of [bookHtml(), applianceHtml()]) {
      expect((html.match(/<span[^>]*background-color/g) ?? []).length).toBeLessThanOrEqual(3);
      expect(html).toMatch(/<th[^>]*background-color/);
      expect(html).toContain("border:1px solid #e5e7eb");
    }
  });

  it("[REQ-031] 소제목은 작은 번호(01, 02…) 위의 굵은 제목이고 이모지가 없으며, 구매 링크 제목만 번호가 없다", () => {
    for (const html of [bookHtml(), applianceHtml()]) {
      const headings = [...html.matchAll(new RegExp(`<p><b><span style="font-size:${HEADING_SIZE_PX}px[^>]*>([^<]*)</span></b></p>`, "g"))].map((m) => m[1]!);
      expect(headings.length).toBeGreaterThan(2);
      for (const heading of headings) expect(heading).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(headings.at(-1)).toBe("구매 링크");
      const labels = [...html.matchAll(/<p><b><span style="font-size:13px;color:#[0-9a-f]{6}">(\d{2})<\/span><\/b><\/p>/g)].map((m) => m[1]);
      expect(labels).toEqual(labels.map((_, i) => String(i + 1).padStart(2, "0")));
      expect(labels.length).toBe(headings.length - 1);
    }
  });

  it("[REQ-031] 구분선은 본문과 구매 링크 사이, 맨 끝 두 곳뿐이다(섹션 사이는 빈 줄)", () => {
    for (const html of [bookHtml(), applianceHtml()]) {
      expect((html.match(/<hr>/g) ?? []).length).toBe(2);
      expect(html.indexOf("<hr>")).toBeLessThan(html.indexOf("구매 링크"));
      expect(html.lastIndexOf("<hr>")).toBeGreaterThan(html.indexOf("구매 링크"));
      expect(html).toContain("<p>\u200b</p>");
    }
  });

  it("[REQ-031] 이모지는 도입·마무리에만 글당 8개 이내이고, 글 번호에 따라 돌려 쓰며 같은 글은 늘 같다", () => {
    const count = (html: string): number => (textOf(html).match(/\p{Extended_Pictographic}/gu) ?? []).length;
    for (const html of [bookHtml(), applianceHtml()]) {
      expect(count(html)).toBeGreaterThan(0);
      expect(count(html)).toBeLessThanOrEqual(EMOJI_MAX_PER_POST);
    }
    expect(bookHtml(7)).toBe(bookHtml(7));
    expect(bookHtml(7)).not.toBe(bookHtml(8));
  });

  it("[REQ-010][REQ-031] 대가성 문구는 글 위·아래 두 곳에 13px 진회색으로 들어가고 숨기지 않으며 임시저장 화면 검증 텍스트를 그대로 담는다", () => {
    const html = bookHtml();
    expect((html.match(new RegExp(DISCLOSURE_TEXTS.yes24.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(2);
    expect((html.match(/font-size:13px;color:#495057/g) ?? []).length).toBe(2);
    expect(html.indexOf(DISCLOSURE_TEXTS.yes24)).toBeLessThan(html.indexOf("하루가 긴 날엔")); // 첫 본문보다 앞
    expect(html).not.toMatch(/display:\s*none|visibility:\s*hidden|font-size:\s*[0-9]px/);
    const d = draft(styled, [product("1")]);
    expect(missingDisclosures(renderNaverHtml(d), d.products)).toEqual([]);
    expect(missingTexts(textOf(renderNaverHtml(d)).replace(/\|/g, " "), requiredDisclosures(d.products))).toEqual([]);
  });

  it("[REQ-031] 구매 링크는 문장 속에 넣어 에디터가 링크 카드를 만들지 않게 한다(링크만 있는 문단 없음)", () => {
    const html = bookHtml();
    const linkParagraphs = html.match(/<p[^>]*>(?:(?!<\/p>)[\s\S])*<a href[\s\S]*?<\/p>/g) ?? [];
    expect(linkParagraphs.length).toBe(1);
    expect(textOf(linkParagraphs[0]!).replace(/\|/g, "").length).toBeGreaterThan("책 1".length + 5);
  });

  it("[REQ-031] 새 필드가 없는 옛 본문도 렌더된다(도입·마무리 코너만 빠진다)", () => {
    expect(() => renderNaverHtml(draft(bookBody(), [product("1")]))).not.toThrow();
  });
});

const fakeDriver = (result: Awaited<ReturnType<NaverEditorDriver["saveDraft"]>> | Error) => {
  const saveDraft = vi.fn<NaverEditorDriver["saveDraft"]>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { saveDraft };
};

describe("사진 자리 (REQ-035)", () => {
  const photo = { filePath: "/m/a.jpg", mime: "image/jpeg" as const, bytes: 10 };

  it("[REQ-035] 사진이 있는 초안의 HTML에는 '내 한 컷' 소제목 아래에 사진 자리가 한 번 들어가고, 없으면 자리도 없다", () => {
    const withPhoto = renderNaverHtml({ ...draft(bookBody({ experienceLine: "출퇴근길에 읽었어요" }), [product("1")]), photo });
    expect(withPhoto.split(PHOTO_SLOT_MARKER)).toHaveLength(2);
    expect(withPhoto.indexOf("내 한 컷")).toBeLessThan(withPhoto.indexOf(PHOTO_SLOT_MARKER));
    expect(withPhoto.indexOf(PHOTO_SLOT_MARKER)).toBeLessThan(withPhoto.indexOf("출퇴근길에 읽었어요"));
    expect(renderNaverHtml(draft(bookBody(), [product("1")]))).not.toContain(PHOTO_SLOT_MARKER);
  });

  it("[REQ-035] 메모 없이 사진만 있어도 '내 한 컷' 자리가 생긴다", () => {
    expect(renderNaverHtml({ ...draft(bookBody(), [product("1")]), photo })).toContain(PHOTO_SLOT_MARKER);
  });

  it("[REQ-035] 자리에서 앞·뒤로 나누면 이어 붙였을 때 원문과 같고, 자리가 없으면 null이다", () => {
    const html = renderNaverHtml({ ...draft(bookBody(), [product("1")]), photo });
    const parts = splitAtPhotoSlot(html)!;
    expect(parts.before + PHOTO_SLOT_MARKER + parts.after).toBe(html);
    expect(splitAtPhotoSlot("<p>없음</p>")).toBeNull();
  });

  it("[REQ-035] 임시저장 어댑터는 사진 경로를 드라이버에 그대로 넘긴다", async () => {
    const driver = fakeDriver({ ok: true });
    await createNaverDraftPublisher({ driver }).publish({ draftId: 7, title: "제목", content: "<p>본문</p>", mustContain: [], photoPath: "/m/a.jpg" });
    expect(driver.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ photoPath: "/m/a.jpg" }));
  });

  it("[REQ-035][EDGE-016] 사진 업로드를 확인 못 해 저장 전 실패면 폴백 대상 실패로 보고한다(사진 없이 저장하지 않음)", async () => {
    const publisher = createNaverDraftPublisher({ driver: fakeDriver({ ok: false, reason: "editor_unavailable", detail: "사진 업로드를 확인하지 못해 저장하지 않았어요" }) });
    const result = await publisher.publish({ draftId: 7, title: "제목", content: "x", mustContain: [], photoPath: "/m/a.jpg" });
    expect(result).toMatchObject({ ok: false, mode: "draft", retryable: false });
  });
});

describe("createNaverDraftPublisher — 임시저장 어댑터", () => {
  const post = { draftId: 7, title: "제목", content: "<p>본문</p>", mustContain: ["대가성 문구"] };

  it("[REQ-012] 임시저장되면 draft 모드 성공을 돌려주고, 드라이버엔 제목과 HTML이 그대로 간다", async () => {
    const driver = fakeDriver({ ok: true });
    const publisher = createNaverDraftPublisher({ driver });
    expect(publisher.mode).toBe("draft");
    await expect(publisher.publish(post)).resolves.toEqual({ ok: true, mode: "draft", url: null, externalId: null });
    expect(driver.saveDraft).toHaveBeenCalledWith({ title: "제목", html: "<p>본문</p>", mustContain: ["대가성 문구"] }); // 사진 없으면 photoPath 키도 없다
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

describe("필사 코너 (REQ-029)", () => {
  const quote = { text: "오늘 하루도 충분히 애썼어요.", attribution: "— 『가호』, 하루키", origin: "web" as const };

  it("[REQ-029] 문구가 있으면 '필사하고 싶은 한 줄' 소제목 아래에 문구·출처·이유가 들어가고 '인상 깊은 대목'은 빠진다", () => {
    const html = renderNaverHtml(draft(bookBody({ quote, highlights: "짧고 또렷해서 필사하기 좋아요" }), [product("1")]));
    expect(html).toContain("필사하고 싶은 한 줄");
    expect(html).toContain(quote.text);
    expect(html).toContain("— 『가호』, 하루키");
    expect(html).not.toContain("인상 깊은 대목");
  });

  it("[REQ-029] 소개문에서 온 문구는 소제목이 '이 책 속 한 줄'이다 (출처를 정직하게)", () => {
    const html = renderNaverHtml(draft(bookBody({ quote: { ...quote, origin: "intro", attribution: "— 『가호』 소개글 중" } }), [product("1")]));
    expect(html).toContain("이 책 속 한 줄");
    expect(html).not.toContain("필사하고 싶은 한 줄");
  });

  it("[REQ-029] 문구가 없으면 코너를 빼고 기존 '인상 깊은 대목'을 쓴다", () => {
    const html = renderNaverHtml(draft(bookBody({ highlights: "목차의 구성이 눈에 띄어요" }), [product("1")]));
    expect(html).toContain("인상 깊은 대목");
    expect(html).not.toContain("필사");
  });
});

describe("isNaverUploadedSrc", () => {
  it("[REQ-035] 네이버 서버(pstatic.net) https 주소만 업로드 완료로 본다", () => {
    expect(isNaverUploadedSrc("https://blogfiles.pstatic.net/2026/a.png")).toBe(true);
  });

  it("[REQ-035] data:·blob:·외부·흉내 도메인·빈 값은 업로드 완료가 아니다", () => {
    for (const src of ["", "data:image/png;base64,AAA", "blob:https://blog.naver.com/1234", "https://example.com/a.png", "https://notpstatic.net/a.png", "http://blogfiles.pstatic.net/a.png", "https://pstatic.net.evil.example/a.png"]) {
      expect(isNaverUploadedSrc(src), src).toBe(false);
    }
  });
});
