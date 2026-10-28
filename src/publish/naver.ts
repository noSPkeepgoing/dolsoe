import type { PublishResult } from "@contract/domain.js";

import { PHOTO_SLOT_MARKER, renderStyledHtml } from "./naver-style.js";
import type { Post, Publisher } from "./publisher.js";

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
  saveDraft(input: { title: string; html: string; mustContain: readonly string[]; photoPath?: string }): Promise<NaverEditorOutcome>;
}

const collapseSpaces = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 에디터 화면 전체 텍스트에서 빠진 문구(공백·줄바꿈 차이 무시). 붙여넣기가 잘려 대가성 문구가 사라진 글이 저장되지 않게 드라이버가 저장 전에 건다(REQ-010). */
export function missingTexts(editorText: string, required: readonly string[]): string[] {
  const haystack = collapseSpaces(editorText);
  return required.filter((text) => !haystack.includes(collapseSpaces(text)));
}

/** 네이버 에디터에 붙여넣을 최종 본문 HTML. 서식은 naver-style.ts가 입힌다(P3, ADR-011). */
export const renderNaverHtml = renderStyledHtml;

/** REQ-035: 본문 HTML을 사진 자리(`PHOTO_SLOT_MARKER`)에서 앞·뒤로 나눈다. 자리가 없으면 null — 사진을 어디에 넣을지 알 수 없으니 호출 쪽이 저장 전에 실패시킨다. */
export function splitAtPhotoSlot(html: string): { before: string; after: string } | null {
  const index = html.indexOf(PHOTO_SLOT_MARKER);
  if (index === -1) return null;
  return { before: html.slice(0, index), after: html.slice(index + PHOTO_SLOT_MARKER.length) };
}

/**
 * 사다리 ③(ADR-005 개정): 브라우저로 네이버 에디터에 글을 채우고 임시저장까지만 한다. 공개는 사람이 한다.
 * 저장을 누르기 전에 명확히 막힌 경우(세션 만료·에디터 못 찾음)는 retryable=false 실패로 돌려 ④ 텔레그램 전달로 내려가게 한다.
 * 저장을 눌렀는데 완료를 확인 못 한 경우와 드라이버가 던진 경우는 올라갔는지 알 수 없으므로 던져서 Orchestrator가 결과 불확실로 멈추게 한다(ADR-006) —
 * 폴백하면 임시저장 글과 텔레그램 본문이 겹쳐 중복 글이 된다.
 */
export function createNaverDraftPublisher(deps: { driver: NaverEditorDriver }): Publisher {
  return {
    mode: "draft",
    render: renderNaverHtml,
    async publish(post: Post): Promise<PublishResult> {
      const outcome = await deps.driver.saveDraft({
        title: post.title,
        html: post.content,
        mustContain: post.mustContain,
        ...(post.photoPath === undefined ? {} : { photoPath: post.photoPath }),
      });
      if (outcome.ok) return { ok: true, mode: "draft", url: null, externalId: null };
      if (outcome.reason === "save_unconfirmed") throw new Error(outcome.detail);
      const authExpired = outcome.reason === "auth_expired";
      return { ok: false, mode: "draft", retryable: false, authExpired, reason: authExpired ? "네이버 로그인 세션이 만료됐어요" : outcome.detail };
    },
  };
}

const NAVER_IMAGE_HOST_SUFFIX = "pstatic.net"; // 네이버 서버에 올라간 이미지는 blogfiles.pstatic.net에 놓인다(스파이크 실측)

/** 에디터 이미지 src가 네이버 서버에 올라간 것인가. `data:`·`blob:`(올라가는 중 임시 미리보기)·외부 URL은 아니다. */
export function isNaverUploadedSrc(src: string): boolean {
  try {
    const { protocol, hostname } = new URL(src);
    return protocol === "https:" && (hostname === NAVER_IMAGE_HOST_SUFFIX || hostname.endsWith(`.${NAVER_IMAGE_HOST_SUFFIX}`));
  } catch {
    return false;
  }
}
