import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { ownerOnly, type ProcessedUpdates } from "./owner-only.js";

const OWNER = 111;

const makeCtx = (o: { chatId?: number; fromId?: number; updateId: number }): Context =>
  ({
    chat: o.chatId === undefined ? undefined : { id: o.chatId },
    from: o.fromId === undefined ? undefined : { id: o.fromId },
    update: { update_id: o.updateId },
  }) as unknown as Context;

const makeStore = (): ProcessedUpdates & { seen: Set<number> } => {
  const seen = new Set<number>();
  return {
    seen,
    markProcessed: (updateId) => {
      if (seen.has(updateId)) return false;
      seen.add(updateId);
      return true;
    },
  };
};

const run = async (ctx: Context, store: ProcessedUpdates) => {
  const next = vi.fn(async () => {});
  await ownerOnly(OWNER, store)(ctx, next);
  return next;
};

describe("ownerOnly", () => {
  it("[REQ-014] 소유자의 메시지는 다음 핸들러로 통과한다", async () => {
    const next = await run(makeCtx({ chatId: OWNER, fromId: OWNER, updateId: 1 }), makeStore());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("[REQ-014] 다른 chat_id의 메시지는 응답도 처리도 하지 않는다", async () => {
    const next = await run(makeCtx({ chatId: 222, fromId: 222, updateId: 2 }), makeStore());
    expect(next).not.toHaveBeenCalled();
  });

  it("[REQ-014] 소유자 채팅이라도 다른 사용자가 누른 버튼(콜백)은 무시한다", async () => {
    const next = await run(makeCtx({ chatId: OWNER, fromId: 222, updateId: 3 }), makeStore());
    expect(next).not.toHaveBeenCalled();
  });

  it("[REQ-014] chat 정보가 없는 update(인라인 쿼리 등)는 무시한다", async () => {
    const next = await run(makeCtx({ fromId: OWNER, updateId: 4 }), makeStore());
    expect(next).not.toHaveBeenCalled();
  });

  it("[REQ-014] 소유자가 아닌 update는 processed_updates에 기록하지 않는다(스팸으로 DB가 불어나지 않게)", async () => {
    const store = makeStore();
    await run(makeCtx({ chatId: 222, fromId: 222, updateId: 5 }), store);
    expect(store.seen.size).toBe(0);
  });

  it("[ADR-004] 같은 update_id가 두 번 오면 한 번만 처리한다", async () => {
    const store = makeStore();
    const first = await run(makeCtx({ chatId: OWNER, fromId: OWNER, updateId: 6 }), store);
    const second = await run(makeCtx({ chatId: OWNER, fromId: OWNER, updateId: 6 }), store);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
