import type { Context, MiddlewareFn } from "grammy";

/** 텔레그램 update 중복 처리 방지 저장소(ADR-004). db.ts의 markUpdateProcessed를 main.ts가 이 모양으로 감싼다. */
export interface ProcessedUpdates {
  markProcessed(updateId: number): boolean;
}

/**
 * REQ-014: 소유자 외의 update는 응답도 처리도 하지 않고 버린다.
 * chat과 발신자(from)가 모두 소유자여야 통과 — 소유자 채팅에서 다른 사람이 누른 버튼도 막는다.
 * 소유자 확인을 먼저 하므로 남의 update는 DB에 쌓이지 않는다.
 */
export function ownerOnly(ownerChatId: number, store: ProcessedUpdates): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (ctx.chat?.id !== ownerChatId || ctx.from?.id !== ownerChatId) return;
    if (!store.markProcessed(ctx.update.update_id)) return;
    await next();
  };
}
