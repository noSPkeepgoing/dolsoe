import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";

import type { BotCallback, Draft, PendingMedia } from "@contract/domain.js";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { formatCard, formatFailureButtons, splitMessage } from "./card.js";

/** 소유자 채팅으로 보내는 전달기. 초안 카드·완성 본문·알림이 모두 여기를 지난다(한도 분할도 한 곳에서). */
export function createMessenger(api: Pick<Api, "sendMessage">, chatId: number) {
  const sendText = async (text: string): Promise<void> => {
    for (const chunk of splitMessage(text, TELEGRAM_MAX_MESSAGE_CHARS)) await api.sendMessage(chatId, chunk);
  };
  return {
    notify: sendText,
    async deliverCard(draft: Draft): Promise<void> {
      const { text, buttons } = formatCard(draft);
      const keyboard = new InlineKeyboard();
      for (const button of buttons) keyboard.text(button.label, button.data);
      await api.sendMessage(chatId, text, { reply_markup: keyboard });
    },
    /** REQ-034: 보낸 사진·메모를 어느 초안에 붙일지 대기 초안 버튼으로 묻는다(+취소). */
    async askAttach(drafts: Draft[], media: PendingMedia): Promise<void> {
      const keyboard = new InlineKeyboard();
      for (const draft of drafts) {
        const callback: BotCallback = { action: "attach", draftId: draft.id };
        keyboard.text(`#${draft.id} ${draft.body?.title ?? "초안"}`.slice(0, 40), JSON.stringify(callback)).row();
      }
      keyboard.text("취소", JSON.stringify({ action: "attach_cancel" } satisfies BotCallback));
      await api.sendMessage(chatId, `${media.kind === "photo" ? "사진을" : "메모를"} 어느 글에 붙일까요?`, { reply_markup: keyboard });
    },
    /** 한도 분할 없이 한 통만 보낸다. 핸드오프 발행기가 몇 통까지 나갔는지 알아야 해서(REQ-013) 따로 노출한다. */
    sendChunk: async (text: string): Promise<void> => {
      await api.sendMessage(chatId, text);
    },
    /** REQ-013: 발행 실패 알림. `다시 시도 / 폐기` 버튼을 붙여 failed 초안을 사람이 이어받게 한다. */
    async notifyFailure(draftId: number, text: string): Promise<void> {
      const keyboard = new InlineKeyboard();
      for (const button of formatFailureButtons(draftId)) keyboard.text(button.label, button.data);
      await api.sendMessage(chatId, text, { reply_markup: keyboard });
    },
  };
}
