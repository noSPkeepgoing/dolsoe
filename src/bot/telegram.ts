import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";

import type { Draft } from "@contract/domain.js";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { formatCard, splitMessage } from "./card.js";

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
    /** 1.3 임시 핸드오프(복붙용 완성 본문). 1.4에서 TelegramHandoffPublisher로 대체된다. */
    deliverPost: sendText,
  };
}
