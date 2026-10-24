import type { Category, Draft, DraftBody, Product } from "@contract/domain.js";
import { EMOJI_MAX_PER_POST } from "@contract/domain.js";

import { computeFacts, factLinesFor } from "../draft/facts.js";

import { requiredDisclosures } from "./disclosure.js";
import { formatPrice, titleOf } from "./renderer.js";

/**
 * 네이버 에디터용 서식(P3, ADR-011): 글자 크기·색·형광펜·인용구·구분선·이모지는 이 파일만 안다. 본문(`DraftBody`)에는 의미 단위만 있다.
 * 스파이크(2026-10-21)로 인라인 span의 크기·색·형광펜, `<blockquote>`, `<hr>`, 표 헤더 배경색이 에디터에서 유지됨을 확인했다.
 * 디자인 원칙(2026-10-24 재설계): 위계는 색이 아니라 크기·굵기로, 색은 작은 곳(번호 라벨·형광펜·표 머리·콜아웃)에만, 이모지는 도입·마무리에만, 구분선은 두 곳만.
 */
export const BODY_COLOR = "#333333";
export const BODY_SIZE_PX = 16; // 에디터 기본 크기 중 레퍼런스에서 가장 많이 쓰임
export const HEADING_SIZE_PX = 20; // PRD §11 소제목 19~24
export const HEADING_COLOR = "#212529";
export const LABEL_SIZE_PX = 13; // 소제목 위 번호 라벨
export const CALLOUT_SIZE_PX = 17;
export const BORDER_COLOR = "#e5e7eb";
export const DISCLOSURE_COLOR = "#495057";
export const DISCLOSURE_SIZE_PX = 13; // 숨김이 아닌 읽히는 글씨. 글 위·아래 두 곳에 넣는다(REQ-010·031)

interface Theme {
  accent: string;
  highlight: string;
  tint: string; // 표 머리·콜아웃 배경
  emojis: readonly string[];
}

export const BOOK_THEME_ACCENT = "#b4546d"; // 더스티 로즈
export const APPLIANCE_THEME_ACCENT = "#2f8f83"; // 딥 틸

const THEMES: Record<Category, Theme> = {
  book: { accent: BOOK_THEME_ACCENT, highlight: "#f8e4e9", tint: "#f8eff1", emojis: ["📖", "🌿", "☕", "🌙", "🍂", "🕯️", "📚", "🔖"] },
  appliance: { accent: APPLIANCE_THEME_ACCENT, highlight: "#dff1ee", tint: "#eef6f5", emojis: ["💡", "🏠", "🔎", "🍳", "🧺", "🌿", "👍", "📌"] },
};

export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const span = (css: string, inner: string): string => `<span style="${css}">${inner}</span>`;
const bodySpan = (inner: string): string => span(`font-size:${BODY_SIZE_PX}px;color:${BODY_COLOR}`, inner);

/** 글 하나를 그리는 동안의 상태: 글 번호로 시드한 결정적 이모지 로테이션, 글당 이모지 상한(REQ-031, EDGE-024), 소제목 번호. */
class StyleKit {
  private emojiUsed = 0;
  private headingCount = 0;

  constructor(
    private readonly theme: Theme,
    private readonly seed: number,
  ) {}

  /** 다음 이모지. 풀을 글 번호만큼 돌려 시작하고 글 안에서는 겹치지 않으며, 상한을 넘으면 빈 문자열이다. */
  private nextEmoji(): string {
    if (this.emojiUsed >= EMOJI_MAX_PER_POST) return "";
    const emoji = this.theme.emojis[(this.seed + this.emojiUsed) % this.theme.emojis.length] ?? "";
    this.emojiUsed += 1;
    return `${emoji} `;
  }

  paragraph(text: string): string {
    return this.htmlParagraph(escapeHtml(text));
  }

  /** 이미 이스케이프된 HTML 조각(링크 등)을 본문 서식의 문단으로 감싼다. */
  htmlParagraph(html: string): string {
    return `<p>${bodySpan(html)}</p>`;
  }

  /** 첫 문장에만 형광펜. 섹션당 1곳이다. */
  highlightedParagraph(text: string): string {
    const [first = text, ...rest] = text.split(/(?<=[.!?。])\s+/);
    const mark = span(`font-size:${BODY_SIZE_PX}px;color:${BODY_COLOR};background-color:${this.theme.highlight}`, escapeHtml(first));
    return `<p>${mark}${rest.length > 0 ? bodySpan(` ${escapeHtml(rest.join(" "))}`) : ""}</p>`;
  }

  /** 도입·마무리: 이모지 1개를 앞에 붙인 문단. */
  emojiParagraph(text: string): string {
    return `<p>${bodySpan(`${this.nextEmoji()}${escapeHtml(text)}`)}</p>`;
  }

  /** 빈 줄. 섹션 사이는 선이 아니라 여백으로 나눈다. */
  spacer(): string {
    return "<p>\u200b</p>";
  }

  /** 소제목: 작은 액센트 번호(01, 02…) 위에 진한 굵은 제목. 번호는 글 안에서 자동으로 센다. `numbered: false`면 번호 없이 제목만(구매 링크). */
  heading(text: string, options: { numbered?: boolean } = {}): string {
    const title = `<p><b>${span(`font-size:${HEADING_SIZE_PX}px;color:${HEADING_COLOR}`, escapeHtml(text))}</b></p>`;
    if (options.numbered === false) return title;
    this.headingCount += 1;
    const label = String(this.headingCount).padStart(2, "0");
    return `<p><b>${span(`font-size:${LABEL_SIZE_PX}px;color:${this.theme.accent}`, label)}</b></p>\n${title}`;
  }

  /** 기본 인용구 블록. 장식이 커서 글당 한 번(책의 맨 위 문장)만 쓴다. */
  quote(text: string): string {
    return `<blockquote><p>${bodySpan(escapeHtml(text))}</p></blockquote>`;
  }

  /** 연한 색조의 1칸 박스: 한 줄 결론 같은 핵심 문장. */
  callout(text: string): string {
    const cell = `border:1px solid ${this.theme.tint};background-color:${this.theme.tint};padding:14px`;
    return `<table style="border-collapse:collapse;width:100%"><tr><td style="${cell}"><b>${span(`font-size:${CALLOUT_SIZE_PX}px;color:${HEADING_COLOR}`, escapeHtml(text))}</b></td></tr></table>`;
  }

  /** 총평 같은 마무리 한 줄: 액센트 라벨 + 굵은 문장. */
  summary(label: string, text: string): string {
    return `<p>${span(`font-size:${BODY_SIZE_PX}px;color:${this.theme.accent}`, `<b>${escapeHtml(label)}</b>`)} ${span(`font-size:${BODY_SIZE_PX}px;color:${HEADING_COLOR}`, `<b>${escapeHtml(text)}</b>`)}</p>`;
  }

  divider(): string {
    return "<hr>";
  }

  /** 표: 머리만 옅은 색조, 선은 얇은 연회색. */
  table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    const line = `border:1px solid ${BORDER_COLOR};padding:8px`;
    const head = `<tr>${headers.map((cell) => `<th style="${line};background-color:${this.theme.tint}">${bodySpan(`<b>${escapeHtml(cell)}</b>`)}</th>`).join("")}</tr>`;
    const body = rows.map((row) => `<tr>${row.map((cell) => `<td style="${line}">${bodySpan(escapeHtml(cell))}</td>`).join("")}</tr>`);
    return `<table style="border-collapse:collapse;width:100%">\n${[head, ...body].join("\n")}\n</table>`;
  }

  /** 대가성 문구: 작은 진회색 글씨지만 숨기지 않는다(REQ-010·031). */
  disclosure(text: string): string {
    return `<p>${span(`font-size:${DISCLOSURE_SIZE_PX}px;color:${DISCLOSURE_COLOR}`, escapeHtml(text))}</p>`;
  }

  /** 판단 문장 옆 근거 팩트 한 줄(REQ-028): 본문보다 작고 옅게. */
  note(text: string): string {
    return `<p>${span(`font-size:${DISCLOSURE_SIZE_PX}px;color:${DISCLOSURE_COLOR}`, escapeHtml(text))}</p>`;
  }

  /** 해시태그 줄: 본문보다 작고 옅게. */
  tagLine(tags: readonly string[]): string {
    return `<p>${span(`font-size:${DISCLOSURE_SIZE_PX}px;color:${this.theme.accent}`, escapeHtml(tags.map((tag) => `#${tag}`).join(" ")))}</p>`;
  }
}

/**
 * 구매 링크 섹션. 링크만 있는 문단이면 에디터가 OG 링크 카드를 글 끝에 붙이므로(스파이크 2026-10-23),
 * 링크를 문장 속에 넣어 카드가 대가성 문구 앞에 끼어들지 않게 한다. http(s)만 링크로 만든다.
 */
function linkSentences(kit: StyleKit, products: readonly Product[]): string {
  return products
    .map((product) => {
      const price = formatPrice(product);
      const safe = /^https?:\/\//i.test(product.url);
      const name = safe ? `<a href="${escapeHtml(product.url)}">${escapeHtml(product.title)}</a>` : escapeHtml(product.title);
      const tail = price === null ? "에서 자세히 볼 수 있어요" : `에서 볼 수 있어요 (${escapeHtml(price)})`;
      return kit.htmlParagraph(`${name}${tail}`);
    })
    .join("\n");
}

/** 섹션 = 소제목 하나와 그 내용. 섹션 사이는 구분선이 아니라 빈 줄이다. */
type Section = string[];

/** 책: 맨 위 인용구(도입) → 도서 정보 표 → 줄거리 → 분위기 → 이런 사람에게 → 인상 깊은 대목. */
function bookSections(kit: StyleKit, body: Extract<DraftBody, { category: "book" }>, products: readonly Product[]): Section[] {
  const product = products[0];
  const author = product?.specs["저자"];
  const price = product === undefined ? null : formatPrice(product);
  const infoHeaders = ["제목", ...(author === undefined ? [] : ["저자"]), ...(price === null ? [] : ["가격"])];
  const infoRow = [product?.title ?? body.title, ...(author === undefined ? [] : [author]), ...(price === null ? [] : [price])];
  return [
    [...(body.intro === undefined ? [] : [kit.quote(body.intro)]), kit.table(infoHeaders, [infoRow])],
    [kit.heading("줄거리"), kit.paragraph(body.synopsis)],
    [kit.heading("분위기"), kit.highlightedParagraph(body.mood)],
    [kit.heading("이런 사람에게"), kit.highlightedParagraph(body.recommendedFor)],
    [kit.heading("인상 깊은 대목"), kit.paragraph(body.highlights)],
  ];
}

/** 가전: 한 줄 결론 콜아웃 → 한눈에 비교 → 이런 사람에게 → 총평. */
function applianceSections(kit: StyleKit, body: Extract<DraftBody, { category: "appliance" }>, products: readonly Product[]): Section[] {
  const facts = computeFacts(products);
  // 판단 문장 옆에 코드가 계산한 근거 팩트의 수치 한 줄을 붙인다(REQ-028).
  const recommendations = body.recommendations.map((rec) =>
    [
      kit.paragraph(`${rec.forWhom} → ${titleOf(products, rec.productExternalId)}: ${rec.reason}`),
      ...factLinesFor(rec.factIds, facts).map((line) => kit.note(`근거: ${line}`)),
    ].join("\n"),
  );
  const intro = body.intro === undefined ? [] : [kit.emojiParagraph(body.intro), kit.spacer()];
  const sections: Section[] = [
    [...intro, kit.heading("한 줄 결론"), kit.callout(body.verdict)],
    [kit.heading("한눈에 비교"), kit.table(body.comparison.headers, body.comparison.rows)],
    [kit.heading("이런 사람에게"), ...recommendations],
  ];
  if (body.closing !== undefined) sections.push([kit.summary("총평", body.closing)]);
  return sections;
}

/**
 * REQ-035: 내 한 컷 사진이 들어갈 자리. HTML 주석이라 붙여넣어도 보이지 않고, 에디터 드라이버가 이 지점에서 HTML을 둘로 나눠
 * 앞부분 → 사진 → 뒷부분 순서로 붙인다(에디터가 HTML 속 `data:` 이미지를 버리는 제약 우회, ADR-014).
 */
export const PHOTO_SLOT_MARKER = "<!--dolsoe:photo-->";

/** 네이버 에디터에 붙여넣을 최종 본문 HTML(제목은 에디터 제목칸에 따로 들어간다). 대가성 문구(REQ-010)·가격 기준일·경험 한 줄(REQ-011) 규칙은 텍스트 렌더러와 같다. */
export function renderStyledHtml(draft: Draft): string {
  if (draft.body === null) throw new Error(`draft #${draft.id} has no body to render`);
  const body = draft.body;
  const kit = new StyleKit(THEMES[body.category], draft.id);
  const disclosures = requiredDisclosures(draft.products);
  const sections = body.category === "book" ? bookSections(kit, body, draft.products) : applianceSections(kit, body, draft.products);

  const experience = (body.experienceLine ?? "").trim();
  const hasPhoto = draft.photo != null;
  if (experience.length > 0 || hasPhoto) {
    sections.push([kit.heading("내 한 컷"), ...(hasPhoto ? [PHOTO_SLOT_MARKER] : []), ...(experience.length > 0 ? [kit.paragraph(experience)] : [])]);
  }
  // 책의 마무리는 구매 링크 앞 문단이다(가전의 마무리는 총평 줄로 이미 들어갔다).
  const bookClosing = body.category === "book" && body.closing !== undefined ? [kit.emojiParagraph(body.closing), kit.spacer()] : [];

  // 대가성 문구는 글 맨 위(제목 바로 아래)와 맨 아래 두 곳에 읽히는 크기로 넣는다. 태그는 맨 아래 본문 줄(임시저장에 태그가 안 남는 점을 우회, ADR-011).
  const tags = body.tags === undefined || body.tags.length === 0 ? [] : [kit.tagLine(body.tags)];
  const content = sections.map((parts) => parts.join("\n")).join(`\n${kit.spacer()}\n`);
  const links = [...bookClosing, kit.heading("구매 링크", { numbered: false }), linkSentences(kit, draft.products)].join("\n");
  // 구분선은 본문과 구매 링크 사이, 맨 끝 두 곳뿐이다(에디터 구분선은 자체 여백이 있어 빈 줄을 덧붙이지 않는다).
  return [
    ...disclosures.map((text) => kit.disclosure(text)),
    kit.spacer(),
    content,
    kit.divider(),
    links,
    kit.divider(),
    ...tags,
    ...disclosures.map((text) => kit.disclosure(text)),
  ].join("\n");
}
