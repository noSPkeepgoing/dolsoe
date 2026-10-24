import { GrammyError } from "grammy";

import { TELEGRAM_MAX_MESSAGE_CHARS } from "@contract/domain.js";

import { splitMessage } from "../bot/card.js";

import type { Publisher } from "./publisher.js";
import { renderPostText } from "./renderer.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 텔레그램이 요청을 명확히 거절한 경우(4xx, 429 포함)만 "안 나갔다"고 확신할 수 있다.
 * 네트워크 오류·타임아웃·5xx는 서버가 이미 받았을 수 있어 재시도하면 본문이 중복 전달된다(ADR-006).
 */
const isClearRejection = (error: unknown): boolean =>
  error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500;

/**
 * 사다리 ③(ADR-005): 완성 본문을 텔레그램으로 보내 사람이 복붙 발행한다. 네이버 API 없이도 MVP가 성립하는 기본 발행기.
 * 통을 하나씩 직접 보내 몇 통까지 나갔는지 안다 — 일부만 나간 뒤 실패하거나 거절이 불명확하면 재시도가 본문을 중복 전달하므로 retryable=false.
 */
export function createHandoffPublisher(deps: { sendChunk: (text: string) => Promise<void>; sendPhoto?: (filePath: string) => Promise<void> }): Publisher {
  return {
    mode: "manual",
    render: renderPostText,
    async publish(post) {
      const chunks = splitMessage(post.content, TELEGRAM_MAX_MESSAGE_CHARS);
      let sent = 0;
      try {
        for (const chunk of chunks) {
          await deps.sendChunk(chunk);
          sent++;
        }
      } catch (error) {
        const reason = sent === 0 ? messageOf(error) : `본문 ${chunks.length}통 중 일부(${sent}통)만 전달된 뒤 실패: ${messageOf(error)}`;
        return { ok: false, mode: "manual", retryable: sent === 0 && isClearRejection(error), authExpired: false, reason };
      }
      // REQ-035: 본문 뒤에 내 한 컷 사진을 함께 보낸다. 본문은 이미 나갔으니 사진만 실패해도 재시도(=본문 중복)는 하지 않고 사유를 알린다.
      if (post.photoPath !== undefined && deps.sendPhoto !== undefined) {
        try {
          await deps.sendPhoto(post.photoPath);
        } catch (error) {
          return { ok: false, mode: "manual", retryable: false, authExpired: false, reason: `본문은 전달됐지만 사진 전송에 실패했어요: ${messageOf(error)}` };
        }
      }
      return { ok: true, mode: "manual", url: null, externalId: null };
    },
  };
}
