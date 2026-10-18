import type { Draft, DraftBody, Product, PublishResult } from "@contract/domain.js";

import { requiredDisclosures } from "./disclosure.js";
import type { Post, Publisher } from "./publisher.js";
import { formatPrice, titleOf } from "./renderer.js";

/** 네이버 블로그 에디터를 다루는 부분(브라우저)의 경계. 선택자·URL 같은 네이버 화면 지식은 이 인터페이스 뒤(naver-playwright.ts)에만 둔다(P3). */
export type NaverEditorOutcome =
  | { ok: true }
  | {
      ok: false;
      /** auth_expired: 로그인 화면으로 튕김 · editor_unavailable: 에디터/버튼을 못 찾음 · save_unconfirmed: 저장을 눌렀지만 완료를 확인하지 못함 */
      reason: "auth_expired" | "editor_unavailable" | "save_unconfirmed";
      detail: string;
    };

export interface NaverEditorDriver {
  /** 새 글에 제목·본문(HTML)을 넣고 임시저장만 한다. 발행은 절대 하지 않는다. 결과를 알 수 없게 죽으면 던진다. */
  saveDraft(input: { title: string; html: string }): Promise<NaverEditorOutcome>;
}

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const paragraph = (text: string): string => `<p>${escapeHtml(text)}</p>`;
const section = (heading: string, text: string): string => `<h3>${heading}</h3>\n${paragraph(text)}`;

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `<tr>${headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`);
  return `<table border="1">\n${[head, ...body].join("\n")}\n</table>`;
}

/** 제목은 에디터의 제목칸에 따로 들어가므로 본문에는 넣지 않는다. 구매 링크·경험·대가성 문구는 텍스트 렌더러(renderer.ts)와 같은 규칙으로 붙인다. */
function renderBodyHtml(body: DraftBody, products: readonly Product[]): string[] {
  if (body.category === "appliance") {
    const recommendations = body.recommendations.map((rec) => paragraph(`${rec.forWhom} → ${titleOf(products, rec.productExternalId)}: ${rec.reason}`));
    return [section("한 줄 결론", body.verdict), renderTable(body.comparison.headers, body.comparison.rows), `<h3>누구에게 어떤 제품</h3>\n${recommendations.join("\n")}`];
  }
  return [section("줄거리", body.synopsis), section("분위기", body.mood), section("이런 사람에게", body.recommendedFor), section("인상 깊은 대목", body.highlights)];
}

function renderLinksHtml(products: readonly Product[]): string {
  const items = products.map((product) => {
    const price = formatPrice(product);
    const link = `<a href="${escapeHtml(product.url)}">${escapeHtml(product.title)}</a>`;
    return `<p>${link}${price === null ? "" : ` — ${escapeHtml(price)}`}</p>`;
  });
  return `<h3>구매 링크</h3>\n${items.join("\n")}`;
}

/** 네이버 에디터에 붙여넣을 최종 본문 HTML. 대가성 문구(REQ-010)·가격 기준일·경험 한 줄(REQ-011) 규칙은 텍스트 렌더러와 같다. */
export function renderNaverHtml(draft: Draft): string {
  if (draft.body === null) throw new Error(`draft #${draft.id} has no body to render`);
  const sections = [...renderBodyHtml(draft.body, draft.products), renderLinksHtml(draft.products)];
  const experience = (draft.body.experienceLine ?? "").trim();
  if (experience.length > 0) sections.push(section("내 경험", experience));
  const disclosures = requiredDisclosures(draft.products).map(paragraph);
  return [...sections, ...disclosures].join("\n");
}

/**
 * 사다리 ③(ADR-005 개정): 브라우저로 네이버 에디터에 글을 채우고 임시저장까지만 한다. 공개는 사람이 한다.
 * 화면에서 명확히 막힌 경우(세션 만료·에디터 못 찾음·저장 확인 실패)는 retryable=false 실패로 돌려 ④ 텔레그램 전달로 내려가게 하고,
 * 드라이버가 던지면 그대로 던져 Orchestrator가 결과 불확실로 멈추게 한다(ADR-006).
 */
export function createNaverDraftPublisher(deps: { driver: NaverEditorDriver }): Publisher {
  return {
    mode: "draft",
    render: renderNaverHtml,
    async publish(post: Post): Promise<PublishResult> {
      const outcome = await deps.driver.saveDraft({ title: post.title, html: post.content });
      if (outcome.ok) return { ok: true, mode: "draft", url: null, externalId: null };
      const authExpired = outcome.reason === "auth_expired";
      return { ok: false, mode: "draft", retryable: false, authExpired, reason: authExpired ? "네이버 로그인 세션이 만료됐어요" : outcome.detail };
    },
  };
}
