import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

import { getDraft, insertDraft, openDb } from "../db.js";
import type { ApprovalDeps } from "../draft/approval.js";
import { expectedExperienceLine, type BodyGenerator, type GenerateBodyInput } from "../draft/generate.js";
import { createApprovalStore, createDraftStore, createPublishStore } from "../draft/store.js";
import type { LinkDraftDeps } from "../jobs/link-draft.js";
import { createHandoffPublisher } from "../publish/handoff.js";
import type { PublishDeps } from "../publish/orchestrator.js";
import type { Publisher } from "../publish/publisher.js";

import { registerHandlers } from "./handlers.js";
import { createMessenger } from "./telegram.js";

const OWNER = 111;
const NOW = new Date("2026-10-02T00:00:00.000Z");

const product = (id: string): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}`,
  priceKrw: 10000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});

const bodyFor = (input: GenerateBodyInput): DraftBody => {
  const experience = input.revision === undefined ? null : expectedExperienceLine(input.revision);
  return input.category === "book"
    ? {
        category: "book",
        title: input.revision === undefined ? "새 초안" : `수정됨 ${input.revision.instruction.split("\n")[0] ?? ""}`,
        synopsis: "s",
        mood: "m",
        recommendedFor: "r",
        highlights: "h",
        experienceLine: experience,
      }
    : {
        category: "appliance",
        title: "제품 소개",
        verdict: "결론",
        comparison: { headers: ["제품", "가격"], rows: input.products.map((p) => [p.title, "1만원"]) },
        recommendations: [{ forWhom: "누구나", productExternalId: input.products[0]!.externalId, reason: "이유" }],
        experienceLine: experience,
      };
};

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function setup(makePublishers: (sendChunk: (text: string) => Promise<void>) => Publisher[] = (sendChunk) => [createHandoffPublisher({ sendChunk })]) {
  const db = openDb(":memory:");
  const draft = insertDraft(
    db,
    {
      category: "book",
      mode: "daily",
      status: "awaiting_approval",
      products: [product("1")],
      body: { category: "book", title: "원본", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null },
      memo: null,
      quality: { bannedPhrasesFound: [], hasExperienceLine: false },
    },
    NOW,
  );

  const bot = new Bot("123:TEST", {
    botInfo: {
      id: 123, is_bot: true, first_name: "t", username: "t_bot", can_join_groups: false, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
      allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
    },
  });
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });

  const messenger = createMessenger(bot.api, OWNER);
  const generator: BodyGenerator = { generateBody: vi.fn(async (input: GenerateBodyInput) => bodyFor(input)) };
  const approval: ApprovalDeps = { store: createApprovalStore(db, () => NOW), generator, getMonthCostKrw: () => 0, ...messenger };
  const approvalStore = createApprovalStore(db, () => NOW);
  const publish: PublishDeps = {
    store: { ...approvalStore, ...createPublishStore(db, () => NOW) },
    publishers: makePublishers(messenger.sendChunk),
    notify: messenger.notify,
    notifyFailure: messenger.notifyFailure,
  };
  const link: LinkDraftDeps = {
    now: () => NOW,
    generator,
    store: createDraftStore(db, () => NOW),
    resolveYes24: async (id) => product(id),
    notify: messenger.notify,
    deliverCard: messenger.deliverCard,
  };
  registerHandlers(bot, { approval, publish, link });

  let updateId = 1;
  const user = { id: OWNER, is_bot: false, first_name: "나" };
  const chat = { id: OWNER, type: "private" as const, first_name: "나" };
  return {
    db,
    draft,
    calls,
    generator,
    tap: (data: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        callback_query: { id: `cb${updateId}`, from: user, chat_instance: "ci", data, message: { message_id: 7, date: 0, chat, text: "card" } },
      }),
    say: (text: string) => bot.handleUpdate({ update_id: updateId++, message: { message_id: updateId, date: 0, chat, from: user, text } }),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"])),
    methods: () => calls.map((c) => c.method),
  };
}

const publishData = (id: number) => JSON.stringify({ action: "publish", draftId: id });

describe("registerHandlers", () => {
  it("[REQ-013] 발행이 실패하면 `다시 시도 / 폐기` 버튼이 달린 실패 알림이 오고, 다시 시도를 누르면 이어서 발행된다", async () => {
    let failing = true;
    const flaky: Publisher = {
      mode: "manual",
      render: (draft) => `본문 ${DISCLOSURE_TEXTS.yes24} #${draft.id}`,
      publish: async () =>
        failing ? { ok: false, mode: "manual", retryable: false, authExpired: false, reason: "텔레그램 장애" } : { ok: true, mode: "manual", url: null, externalId: null },
    };
    const { tap, draft, db, calls } = setup(() => [flaky]);

    await tap(publishData(draft.id));
    expect(getDraft(db, draft.id)?.status).toBe("failed");
    const failure = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(String(failure.payload["text"])).toContain("텔레그램 장애");
    expect(JSON.stringify(failure.payload["reply_markup"])).toContain("다시 시도");

    failing = false;
    await tap(publishData(draft.id)); // 다시 시도 버튼은 publish 콜백
    expect(getDraft(db, draft.id)?.status).toBe("handed_off");
  });

  it("[REQ-007][REQ-010] `발행`을 누르면 대가성 문구가 붙은 본문이 오고, 카드 버튼은 사라진다", async () => {
    const { tap, draft, db, sent, methods } = setup();
    await tap(publishData(draft.id));
    expect(methods()).toContain("answerCallbackQuery");
    expect(methods()).toContain("editMessageReplyMarkup");
    expect(sent().some((text) => text.includes(DISCLOSURE_TEXTS.yes24))).toBe(true);
    expect(getDraft(db, draft.id)?.status).toBe("handed_off");
  });

  it("[REQ-009] `발행`을 연달아 두 번 눌러도 본문은 한 번만 온다", async () => {
    const { tap, draft, sent } = setup();
    await tap(publishData(draft.id));
    await tap(publishData(draft.id));
    expect(sent().filter((text) => text.includes(DISCLOSURE_TEXTS.yes24))).toHaveLength(1);
  });

  it("[REQ-008] `폐기`는 초안을 버리고 카드 버튼을 지운다", async () => {
    const { tap, draft, db, methods } = setup();
    await tap(JSON.stringify({ action: "discard", draftId: draft.id }));
    expect(getDraft(db, draft.id)?.status).toBe("discarded");
    expect(methods()).toContain("editMessageReplyMarkup");
  });

  it("[REQ-008][REQ-011] `수정` → 지시 답장 → 경험 한 줄이 원문 그대로 반영된 새 카드(버튼 3개)가 온다", async () => {
    const { tap, say, draft, db, calls } = setup();
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    await say("표를 더 간단히\n경험 한 줄: 소음이 생각보다 컸어요");

    expect(getDraft(db, draft.id)).toMatchObject({
      status: "awaiting_approval",
      body: { experienceLine: "소음이 생각보다 컸어요" },
      quality: { hasExperienceLine: true },
    });
    const card = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(String(card.payload["text"])).toContain("경험 있음");
    expect(JSON.stringify(card.payload["reply_markup"])).toContain("발행");
  });

  it("[REQ-006] 링크 메시지를 보내면 링크 모드 초안 카드가 온다", async () => {
    const { say, db, sent } = setup();
    await say("https://link.coupang.com/a/abc123\n삼성 비스포크 제트 / 899000원\n소음 중요");
    expect(sent().some((text) => text.includes("링크 모드"))).toBe(true);
    const row = db.prepare("SELECT mode, memo FROM drafts WHERE mode = 'link'").get();
    expect(row).toEqual({ mode: "link", memo: "소음 중요" });
  });

  it("[REQ-006] 지원하지 않는 링크는 안내만 오고 초안은 늘지 않는다", async () => {
    const { say, db, sent } = setup();
    await say("https://example.com/a");
    expect(sent().some((text) => text.includes("지원하지 않는"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM drafts").get()).toEqual({ n: 1 });
  });

  it("[REQ-006] 링크도 수정 대기도 아닌 일반 메시지에는 사용법을 안내한다", async () => {
    const { say, sent } = setup();
    await say("안녕");
    expect(sent()[0]).toContain("링크");
  });

  it("[REQ-007] 알 수 없는 버튼 데이터는 서비스를 부르지 않고 콜백 응답만 한다(경계 검증)", async () => {
    const { tap, draft, db, methods } = setup();
    await tap('{"action":"delete","draftId":1}');
    expect(methods()).toEqual(["answerCallbackQuery"]);
    expect(getDraft(db, draft.id)?.status).toBe("awaiting_approval");
  });

  it("[REQ-008] 슬래시 명령은 수정 지시·링크로 처리하지 않는다", async () => {
    const { tap, say, draft, generator } = setup();
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    await say("/ping");
    expect(vi.mocked(generator.generateBody)).not.toHaveBeenCalled();
  });

  it("[REQ-008] `수정` 버튼을 눌러도 카드 버튼은 남는다(수정 대기 중에도 발행·폐기 가능)", async () => {
    const { tap, draft, methods } = setup();
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    expect(methods()).not.toContain("editMessageReplyMarkup");
  });

  it("[REQ-006] 수정 대기 중에 링크를 보내면 링크 모드가 우선하고 수정 대기는 풀린다", async () => {
    const { tap, say, draft, db, generator } = setup();
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    await say("https://link.coupang.com/a/abc123\n샤오미 공기청정기");
    expect(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE mode = 'link'").get()).toEqual({ n: 1 });
    expect(vi.mocked(generator.generateBody).mock.calls[0]![0].revision).toBeUndefined();
    await say("그냥 한마디");
    expect(vi.mocked(generator.generateBody)).toHaveBeenCalledTimes(1); // 수정 지시로 쓰이지 않음
  });
});
