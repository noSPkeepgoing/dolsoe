import type { Product } from "@contract/domain.js";
import { COUPANG_PARTNER_HOSTS, SPEC_KEYS, YES24_HOST_SUFFIX } from "@contract/domain.js";

export interface CoupangLink {
  type: "coupang";
  url: string;
  /** 단축 링크 경로의 마지막 조각 — 중복 제외 키로 쓴다 */
  code: string;
  title: string;
  priceKrw: number | null;
  /** REQ-028 사용자가 `키 값`으로 직접 적은 스펙(예: `용량 3.5L`). 웹 확인보다 우선한다. */
  specs: Record<string, string>;
}
export interface Yes24Link {
  type: "yes24";
  url: string;
  itemId: string;
}
export type ParsedLink = CoupangLink | Yes24Link;

export type ParsedLinkMessage =
  | { kind: "none" }
  | { kind: "unsupported"; urls: string[] }
  | { kind: "missing_title"; url: string }
  | { kind: "ok"; links: ParsedLink[]; memo: string | null };

const URL_PATTERN = /https?:\/\/[\x21-\x7E]+/g; // ASCII만: 한글이 바로 붙어 와도 링크에 섞이지 않는다
const HAS_URL = /https?:\/\//; // 전역 플래그 정규식은 test()가 lastIndex 상태를 남기므로 확인용은 따로 둔다
const TRAILING_PUNCTUATION = /[),.]+$/;
const PRICE_PATTERN = /(\d[\d,]*)\s*원/;
const NAME_EDGE_SEPARATORS = /^[\s/,|·-]+|[\s/,|·-]+$/g;
const YES24_GOODS_PATH = /goods\/(?:detail\/)?(\d+)/i;

type Classified = { type: "coupang"; url: string; code: string } | { type: "yes24"; url: string; itemId: string };

/** 호스트는 정확히(또는 서브도메인 경계까지) 맞아야 한다 — `link.coupang.com.evil.example`·`notyes24.com` 같은 흉내는 거른다. */
function classifyUrl(url: string): Classified | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // 구매 링크로 그대로 내보내므로 https만, 계정정보·포트가 붙은 변형은 받지 않는다.
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);

  if ((COUPANG_PARTNER_HOSTS as readonly string[]).includes(host)) {
    const code = segments.at(-1);
    return code === undefined ? null : { type: "coupang", url: `https://${host}${parsed.pathname}`, code }; // 추적 쿼리 제거
  }
  if (host === YES24_HOST_SUFFIX || host.endsWith(`.${YES24_HOST_SUFFIX}`)) {
    const itemId = YES24_GOODS_PATH.exec(parsed.pathname)?.[1];
    return itemId === undefined ? null : { type: "yes24", url, itemId };
  }
  return null;
}

const BARE_PRICE = /^\d[\d,]{3,}$/; // "59000" — 4자리 이상 숫자만 있는 조각
const SPEC_TOKEN = new RegExp(`^(${SPEC_KEYS.join("|")})\\s+(\\S.*)$`);

/**
 * "상품명 / 899,000원 / 용량 3.5L" → 상품명·가격(없으면 null)·스펙. 조각은 "/"로 나눈다.
 * 맨 앞 조각은 상품명 자리라 가격·스펙으로 먹지 않는다 — 단 "용량 3.5L"처럼 값이 숫자로 시작하는 `키 값`만 있는 줄은 스펙으로 읽는다.
 * 스펙은 알려진 키(`SPEC_KEYS`)로 시작하는 `키 값` 조각만 인정한다("LG 퓨리케어 360"이 스펙으로 오인되지 않게).
 * 상품명 조각은 원문 그대로 이어 붙인다("A/B"가 "A / B"로 바뀌지 않게). 상품명이 비면 null.
 */
function parseNameLine(text: string): { title: string; priceKrw: number | null; specs: Record<string, string> } | null {
  const specs: Record<string, string> = {};
  let priceKrw: number | null = null;
  const nameParts: string[] = [];
  text.split("/").forEach((raw, index) => {
    const piece = raw.trim();
    if (piece.length === 0) return;
    const spec = SPEC_TOKEN.exec(piece);
    if (spec !== null && (index > 0 || /^\d/.test(spec[2]!.trim()))) {
      specs[spec[1]!] = spec[2]!.trim();
    } else if (index > 0 && BARE_PRICE.test(piece) && priceKrw === null) {
      priceKrw = Number(piece.replaceAll(",", ""));
    } else {
      nameParts.push(raw);
    }
  });
  const name = nameParts.join("/");
  const priceMatch = PRICE_PATTERN.exec(name);
  if (priceMatch !== null && priceKrw === null) priceKrw = Number(priceMatch[1]!.replaceAll(",", ""));
  const title = name.replace(PRICE_PATTERN, "").replace(NAME_EDGE_SEPARATORS, "").trim();
  return title.length === 0 ? null : { title, priceKrw, specs };
}

/**
 * REQ-006: 링크 모드 메시지 해석. 쿠팡은 페이지를 긁지 않으므로(ADR-008) 링크 다음 줄(또는 같은 줄)의 상품명·가격을 쓰고,
 * 그 밖의 줄은 메모다. YES24 링크는 상품번호만 뽑고 상품 정보는 API가 채운다.
 */
export function parseLinkMessage(text: string): ParsedLinkMessage {
  const lines = text.split(/\r?\n/);
  const links: ParsedLink[] = [];
  const unsupported: string[] = [];
  const memoLines: string[] = [];
  let sawUrl = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const urls = (line.match(URL_PATTERN) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION, ""));
    if (urls.length === 0) {
      if (line.trim().length > 0) memoLines.push(line.trim());
      continue;
    }
    sawUrl = true;
    const leftover = line.replace(URL_PATTERN, " ").trim();

    for (const url of urls) {
      const classified = classifyUrl(url);
      if (classified === null) {
        unsupported.push(url);
      } else if (classified.type === "yes24") {
        links.push(classified);
      } else {
        // 링크가 한 줄에 하나일 때만 그 줄의 나머지·다음 줄을 상품명으로 본다
        let nameText = urls.length === 1 ? leftover : "";
        const next = lines[index + 1];
        if (nameText.length === 0 && urls.length === 1 && next !== undefined && next.trim().length > 0 && !HAS_URL.test(next)) {
          nameText = next.trim();
          index++;
        }
        const name = parseNameLine(nameText);
        if (name === null) return { kind: "missing_title", url };
        links.push({ type: "coupang", url: classified.url, code: classified.code, ...name });
      }
    }
    if (urls.length > 1 && leftover.length > 0) memoLines.push(leftover);
    else if (links.at(-1)?.type === "yes24" && leftover.length > 0) memoLines.push(leftover);
  }

  if (!sawUrl) return { kind: "none" };
  if (unsupported.length > 0) return { kind: "unsupported", urls: unsupported };
  return { kind: "ok", links, memo: memoLines.length > 0 ? memoLines.join("\n") : null };
}

/** 쿠팡 링크 → 가전 상품. 가격을 줬을 때만 기준일(지금)을 붙인다(REQ-011: 가격은 기준일과 함께). */
export function coupangLinkToProduct(link: CoupangLink, now: Date): Product {
  return {
    externalId: link.code,
    source: "coupang_link",
    category: "appliance",
    affiliate: "coupang",
    title: link.title,
    url: link.url,
    priceKrw: link.priceKrw,
    priceAsOf: link.priceKrw === null ? null : now.toISOString(),
    specs: link.specs,
  };
}
