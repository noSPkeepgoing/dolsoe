import type { Category, Draft, Product } from "@contract/domain.js";
import { COUPANG_PARTNER_HOSTS, PRODUCTS_PER_DRAFT } from "@contract/domain.js";

import { deliverCardSafely } from "../draft/deliver.js";
import { generateDraftBody, type BodyGenerator } from "../draft/generate.js";
import { isBudgetExceeded } from "../llm/cost.js";
import { coupangLinkToProduct, parseLinkMessage, type ParsedLink } from "../sources/link-parser.js";

import type { DraftStore } from "./daily-draft.js";

export type LinkSkipReason =
  | "not_link"
  | "unsupported"
  | "missing_title"
  | "mixed"
  | "too_many"
  | "budget"
  | "source_error"
  | "generation_error";
export type LinkDraftResult = { status: "created"; draft: Draft } | { status: "skipped"; reason: LinkSkipReason };

export interface LinkDraftDeps {
  now: () => Date;
  generator: BodyGenerator;
  store: DraftStore;
  /** YES24 상품번호 → 수익 링크가 붙은 Product. 못 쓰는 상품이면 사용자에게 보여줄 문장의 예외를 던진다. */
  resolveYes24: (itemId: string) => Promise<Product>;
  notify: (text: string) => Promise<void>;
  deliverCard: (draft: Draft) => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const SUPPORTED_LINKS_GUIDE = `지원하는 링크: 쿠팡 파트너스 링크(${COUPANG_PARTNER_HOSTS.join(", ")}), YES24 상품 링크.`;

/**
 * REQ-006 링크 모드: 보낸 링크(+메모)로 스케줄과 무관하게 즉시 초안을 만든다.
 * 승인 대기 상한(REQ-004)의 예외다 — 내가 직접 요청한 글은 항상 만든다. 월 비용 상한은 지킨다(NFR-001).
 * 링크가 없는 메시지는 아무 알림 없이 not_link로 돌려준다(일반 대화 안내는 호출 쪽이 한다).
 */
export async function runLinkDraft(deps: LinkDraftDeps, text: string): Promise<LinkDraftResult> {
  const { notify } = deps;
  const skip = async (reason: LinkSkipReason, message: string): Promise<LinkDraftResult> => {
    await notify(message);
    return { status: "skipped", reason };
  };

  const parsed = parseLinkMessage(text);
  if (parsed.kind === "none") return { status: "skipped", reason: "not_link" };
  if (parsed.kind === "unsupported") {
    return skip("unsupported", `지원하지 않는 링크가 있어요: ${parsed.urls.join(", ")}\n${SUPPORTED_LINKS_GUIDE}`);
  }
  if (parsed.kind === "missing_title") {
    return skip(
      "missing_title",
      `쿠팡 링크는 페이지를 읽지 않아요. 링크 다음 줄에 상품명(가격은 선택)을 적어 다시 보내주세요.\n예) ${parsed.url}\n삼성 비스포크 제트 / 899000원`,
    );
  }

  const { links, memo } = parsed;
  const types = new Set(links.map((link) => link.type));
  if (types.size > 1) return skip("mixed", "쿠팡 링크와 YES24 링크는 한 종류씩 따로 보내주세요.");

  const category: Category = links[0]!.type === "yes24" ? "book" : "appliance";
  const limit = PRODUCTS_PER_DRAFT[category];
  if (links.length > limit) return skip("too_many", `한 편에는 상품을 ${limit}개까지 쓸 수 있어요. ${links.length}개를 보내주셨어요.`);
  if (isBudgetExceeded(deps.store.getMonthCostKrw())) {
    return skip("budget", "이번 달 LLM 비용 상한에 닿아 초안을 만들지 않았어요. 상한이 풀리면 다시 보내주세요.");
  }

  await notify(`🔗 링크 ${links.length}개 확인 · 초안 만드는 중이에요…`);

  let products: Product[];
  try {
    products = await Promise.all(links.map((link) => resolveProduct(deps, link)));
  } catch (error) {
    return skip("source_error", `상품 정보를 가져오지 못했어요: ${messageOf(error)}`);
  }

  let generated: Awaited<ReturnType<typeof generateDraftBody>>;
  try {
    generated = await generateDraftBody({ generator: deps.generator, category, products, memo });
  } catch (error) {
    return skip("generation_error", `초안 생성에 실패했어요: ${messageOf(error)}`);
  }

  const draft = deps.store.saveDraft(
    { category, mode: "link", status: "awaiting_approval", products, body: generated.body, memo, quality: generated.quality },
    products,
  );
  await deliverCardSafely(deps, draft);
  return { status: "created", draft };
}

const resolveProduct = (deps: LinkDraftDeps, link: ParsedLink): Promise<Product> =>
  link.type === "yes24" ? deps.resolveYes24(link.itemId) : Promise.resolve(coupangLinkToProduct(link, deps.now()));
