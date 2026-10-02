import type { Bot, Context } from "grammy";

import { beginRevision, discardDraft, publishDraft, submitRevision, type ApprovalDeps } from "../draft/approval.js";
import { runLinkDraft, type LinkDraftDeps } from "../jobs/link-draft.js";
import { parseLinkMessage } from "../sources/link-parser.js";

import { parseCallbackData } from "./card.js";

const HELP_TEXT = [
  "상품 링크를 보내면 바로 초안을 만들어 드려요.",
  "• 쿠팡 파트너스 링크: 링크 다음 줄에 상품명(가격은 선택)을 적어주세요.",
  "• YES24 상품 링크: 링크만 보내면 돼요.",
  "• 남은 줄은 글에 반영할 메모로 써요.",
].join("\n");

/** 눌린 카드의 버튼을 지운다(이미 처리된 카드에 다시 누르는 것을 막는 안내 역할). 이미 지워졌거나 실패해도 흐름은 계속한다. */
async function stripButtons(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // 이미 수정됐거나 지울 수 없는 메시지 — 상태는 CAS가 지킨다
  }
}

/**
 * REQ-006~009: 승인 버튼(발행/수정/폐기)과 텍스트 메시지(수정 지시 또는 링크 모드)를 서비스에 연결하는 얇은 배선.
 * 판단은 draft/·jobs/ 서비스가 하고 여기엔 로직이 없다. 소유자 필터(REQ-014)는 앞단 미들웨어가 이미 처리한다.
 */
export function registerHandlers(bot: Bot, deps: { approval: ApprovalDeps; link: LinkDraftDeps }): void {
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const callback = parseCallbackData(ctx.callbackQuery.data);
    if (callback === null) return;

    switch (callback.action) {
      case "publish": {
        const outcome = await publishDraft(deps.approval, callback.draftId);
        if (outcome !== "blocked") await stripButtons(ctx); // 막힌 경우엔 버튼을 남겨 고친 뒤 다시 누를 수 있게 한다
        return;
      }
      case "discard":
        await discardDraft(deps.approval, callback.draftId);
        await stripButtons(ctx);
        return;
      case "revise":
        // 카드 버튼은 남긴다: 수정 대기 중에도 발행·폐기할 수 있어야 하고, 이미 처리된 카드는 CAS가 지킨다.
        await beginRevision(deps.approval, callback.draftId);
        return;
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    if (deps.approval.store.getPendingRevision() !== null) {
      // 수정 대기 중에 링크를 보내면 링크 모드가 우선한다(수정 대기는 풀린다).
      if (parseLinkMessage(text).kind === "none") {
        await submitRevision(deps.approval, text);
        return;
      }
      deps.approval.store.setPendingRevision(null);
    }
    const result = await runLinkDraft(deps.link, text);
    if (result.status === "skipped" && result.reason === "not_link") await ctx.reply(HELP_TEXT);
  });
}
