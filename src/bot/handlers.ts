import type { Bot, Context } from "grammy";

import { beginRevision, discardDraft, submitRevision, type ApprovalDeps } from "../draft/approval.js";
import { attachPending, cancelPending, receiveMemo, receivePhoto, rejectDocumentPhoto, sweepMedia, type MediaDeps } from "../draft/media.js";
import { runLinkDraft, type LinkDraftDeps } from "../jobs/link-draft.js";
import { publishDraft, type PublishDeps } from "../publish/orchestrator.js";
import { parseLinkMessage } from "../sources/link-parser.js";

import { parseCallbackData } from "./card.js";

const HELP_TEXT = [
  "상품 링크를 보내면 바로 초안을 만들어 드려요.",
  "• 쿠팡 파트너스 링크: 링크 다음 줄에 상품명(가격은 선택)을 적어주세요.",
  "• 스펙을 알면 슬래시로 이어 적어도 돼요: 상품명 / 59000 / 용량 3.5L",
  "• YES24 상품 링크: 링크만 보내면 돼요.",
  "• 남은 줄은 글에 반영할 메모로 써요.",
  "• 링크 없이 사진이나 한 줄 메모를 보내면, 어느 초안에 붙일지 물어봐요.",
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
export function registerHandlers(bot: Bot, deps: {
    approval: ApprovalDeps;
    publish: PublishDeps;
    link: LinkDraftDeps;
    media: MediaDeps;
    /** 텔레그램 file_id → 파일 바이트(REQ-034) */
    downloadFile: (fileId: string) => Promise<Uint8Array>;
  },): void {
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const callback = parseCallbackData(ctx.callbackQuery.data);
    if (callback === null) return;

    switch (callback.action) {
      case "publish": {
        const outcome = await publishDraft(deps.publish, callback.draftId);
        if (outcome !== "blocked") await stripButtons(ctx); // 막힌 경우엔 버튼을 남겨 고친 뒤 다시 누를 수 있게 한다
        await sweepMedia(deps.media); // 발행·전달이 끝난 초안의 사진 정리
        return;
      }
      case "discard":
        await discardDraft(deps.approval, callback.draftId);
        await stripButtons(ctx);
        await sweepMedia(deps.media); // 폐기된 초안의 사진 삭제(REQ-034)
        return;
      case "attach":
        await attachPending(deps.media, callback.draftId);
        await stripButtons(ctx);
        return;
      case "attach_cancel":
        await cancelPending(deps.media);
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
    // 링크 없는 일반 텍스트는 메모(REQ-034 ④). 초안이 없으면 안내만 한다.
    if (result.status === "skipped" && result.reason === "not_link") await receiveMemo(deps.media, text);
  });

  bot.on("message:photo", async (ctx) => {
    const largest = ctx.message.photo.at(-1);
    if (largest === undefined) return;
    let bytes: Uint8Array;
    try {
      bytes = await deps.downloadFile(largest.file_id);
    } catch {
      await ctx.reply("사진을 내려받지 못했어요. 다시 보내주세요.");
      return;
    }
    await receivePhoto(deps.media, { bytes, mime: "image/jpeg" }); // 텔레그램 압축 사진은 항상 JPEG
  });

  bot.on("message:document", async (ctx) => {
    if (ctx.message.document.mime_type?.startsWith("image/") === true) await rejectDocumentPhoto(deps.media);
    else await ctx.reply(HELP_TEXT);
  });
}
