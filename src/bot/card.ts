import type { BotCallback, Category, Draft, DraftMode } from "@contract/domain.js";
import { BotCallbackSchema, CARD_PREVIEW_MAX_CHARS } from "@contract/domain.js";

import { formatTags, renderPreview } from "../publish/renderer.js";
import { kstMonthDay } from "../schedule/time.js";

export interface CardButton {
  label: string;
  /** 텔레그램 callback_data(64바이트 한도). `BotCallbackSchema`로 경계 검증한다. */
  data: string;
}

const CATEGORY_LABEL: Record<Category, string> = { appliance: "가전·주방", book: "책 추천" };
const CATEGORY_UNIT: Record<Category, string> = { appliance: "개", book: "권" };
const MODE_LABEL: Record<DraftMode, string> = { daily: "기본 모드", link: "링크 모드" };
const AFFILIATE_LABEL = { coupang: "쿠팡", yes24: "YES24" } as const;
const DIVIDER = "────────────────";

const callbackData = (callback: BotCallback): string => JSON.stringify(callback);

function productsLine(draft: Draft): string {
  const counts = new Map<string, number>();
  for (const product of draft.products) {
    const label = AFFILIATE_LABEL[product.affiliate];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const unit = CATEGORY_UNIT[draft.category];
  const sources = [...counts].map(([label, count]) => `${label} ${count}${unit}`).join(" · ");

  const asOf = draft.products.flatMap((product) => (product.priceAsOf === null ? [] : [product.priceAsOf])).sort().at(-1);
  const priceDate = asOf === undefined ? "" : ` · 가격 기준 ${kstMonthDay(new Date(asOf))}`;
  return `상품: ${sources}${priceDate}`;
}

/** REQ-016: 책 초안이 후기 몇 건을 근거로 썼는지(출처 URL은 카드에 넣지 않는다 — DB에만). 가전에는 줄이 없다. */
function reviewLine(draft: Draft): string | null {
  if (draft.category !== "book") return null;
  const count = draft.reviewSources?.length ?? 0;
  return count > 0 ? `후기 ${count}건 참고` : "후기 근거 없음";
}

const QUOTE_ORIGIN_LABEL = { user: "직접 입력", web: "웹 2곳 확인", intro: "소개글" } as const;

/** REQ-029: 책 초안의 필사 문구 출처. 문구가 없으면 사람에게 보내달라고 요청한다. 가전에는 줄이 없다. */
function quoteLine(draft: Draft): string | null {
  if (draft.category !== "book" || draft.body?.category !== "book") return null;
  const quote = draft.body.quote;
  return quote == null ? "필사 문구: 없음 — 문구를 보내주시면 넣을게요 (수정 → \"문구: …\")" : `필사 문구: ${QUOTE_ORIGIN_LABEL[quote.origin]}`;
}

/** REQ-028: 가전 초안의 스펙 출처 구분("직접 입력 / 웹 확인 N건 / 확인 못 함"). 책에는 줄이 없다. */
function specLine(draft: Draft): string | null {
  if (draft.category !== "appliance") return null;
  const origin = draft.specOrigin;
  const parts = [...((origin?.user ?? 0) > 0 ? ["직접 입력"] : []), ...((origin?.web ?? 0) > 0 ? [`웹 확인 ${origin!.web}건`] : [])];
  return `스펙 출처: ${parts.length > 0 ? parts.join(" · ") : "확인 못 함"}`;
}

/** REQ-007·015: 승인 카드. 본문 미리보기 + 품질 한 줄 + `발행 / 수정 / 폐기` 버튼. 텔레그램 평문(마크업 없음)이라 이스케이프가 필요 없다. */
export function formatCard(draft: Draft): { text: string; buttons: CardButton[] } {
  const quality = draft.quality;
  const qualityLine =
    quality === null
      ? "문체 점검: 검사 전"
      : `문체 점검 · 금지 표현 ${quality.bannedPhrasesFound.length + (quality.styleIssues?.length ?? 0)}개 · 경험 ${quality.hasExperienceLine ? "있음" : "없음"}`;
  const review = reviewLine(draft);
  const spec = specLine(draft);
  const quote = quoteLine(draft);
  const tags = draft.body === null ? null : formatTags(draft.body);
  const text = [
    `📝 초안 #${draft.id} · ${CATEGORY_LABEL[draft.category]} · ${MODE_LABEL[draft.mode]}`,
    DIVIDER,
    renderPreview(draft, CARD_PREVIEW_MAX_CHARS),
    DIVIDER,
    qualityLine,
    productsLine(draft),
    ...(review === null ? [] : [review]),
    ...(spec === null ? [] : [spec]),
    ...(quote === null ? [] : [quote]),
    ...(tags === null ? [] : [`태그: ${tags}`]),
    ...(draft.photo == null ? [] : ["내 한 컷 있음"]),
  ].join("\n");

  const buttons: CardButton[] = [
    { label: "발행", data: callbackData({ action: "publish", draftId: draft.id }) },
    { label: "수정", data: callbackData({ action: "revise", draftId: draft.id }) },
    { label: "폐기", data: callbackData({ action: "discard", draftId: draft.id }) },
  ];
  return { text, buttons };
}

/** REQ-013: 발행 실패 알림의 버튼. 재시도는 `publish` 콜백을 재사용한다(failed → publishing 전이가 허용돼 있다, ADR-006). */
export function formatFailureButtons(draftId: number): CardButton[] {
  return [
    { label: "다시 시도", data: callbackData({ action: "publish", draftId }) },
    { label: "폐기", data: callbackData({ action: "discard", draftId }) },
  ];
}

export function parseCallbackData(data: string): BotCallback | null {
  try {
    const parsed = BotCallbackSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 텔레그램 한 통 한도에 맞춰 줄 경계에서 나눈다. 한 줄이 한도보다 길면 강제로 자른다 — 어떤 경우에도 본문을 잃지 않는다. */
export function splitMessage(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const pieces: string[] = [];
    for (let start = 0; start === 0 || start < line.length; start += limit) pieces.push(line.slice(start, start + limit));
    for (const piece of pieces) {
      if (current === null) {
        current = piece;
      } else if (current.length + 1 + piece.length <= limit) {
        current += `\n${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current !== null) chunks.push(current);
  return chunks;
}
