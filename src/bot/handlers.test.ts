import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";
import { DISCLOSURE_TEXTS } from "@contract/domain.js";

import { getDraft, insertDraft, openDb, type NewDraft } from "../db.js";
import type { ApprovalDeps } from "../draft/approval.js";
import type { MediaDeps, MediaFiles } from "../draft/media.js";
import { expectedExperienceLine, type BodyGenerator, type GenerateBodyInput } from "../draft/generate.js";
import { createApprovalStore, createDraftStore, createMediaStore, createPublishStore } from "../draft/store.js";
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

const baseDraft = (): NewDraft => ({
  category: "book",
  mode: "daily",
  status: "awaiting_approval",
  products: [product("1")],
  body: { category: "book", title: "원본", synopsis: "s", mood: "m", recommendedFor: "r", highlights: "h", experienceLine: null },
  memo: null,
  quality: { bannedPhrasesFound: [], hasExperienceLine: false },
});

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
  const disk = new Map<string, number>(); // 가짜 디스크: 경로 → 바이트 수
  let fileSeq = 0;
  const files: MediaFiles = {
    save: async (bytes) => {
      const filePath = `/media/${++fileSeq}.jpg`;
      disk.set(filePath, bytes.byteLength);
      return filePath;
    },
    remove: async (filePath) => void disk.delete(filePath),
    list: async () => [...disk.keys()],
  };
  const media: MediaDeps = { store: createMediaStore(db, () => NOW), files, notify: messenger.notify, askAttach: messenger.askAttach, deliverCard: messenger.deliverCard };
  const photoBytes = new Uint8Array(1000);
  registerHandlers(bot, { approval, publish, link, media, downloadFile: async () => photoBytes });

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
    disk,
    secondDraft: (overrides: Partial<NewDraft> = {}) =>
      insertDraft(db, { ...baseDraft(), products: [product("2")], ...overrides }, NOW),
    sendPhoto: () =>
      bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: updateId, date: 0, chat, from: user, photo: [{ file_id: "small", file_unique_id: "s", width: 90, height: 90 }, { file_id: "big", file_unique_id: "b", width: 900, height: 900 }] },
      }),
    sendDocument: (mime: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: updateId, date: 0, chat, from: user, document: { file_id: "doc", file_unique_id: "d", mime_type: mime } },
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

  it("[REQ-034] 링크도 수정 대기도 아닌 일반 텍스트는 메모로 보고 어느 글에 붙일지 대기 초안 버튼으로 묻는다", async () => {
    const { say, calls, draft, secondDraft } = setup();
    const second = secondDraft();
    await say("소음이 생각보다 컸어요");
    const ask = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    const markup = JSON.stringify(ask.payload["reply_markup"]);
    expect(String(ask.payload["text"])).toContain("어느 글에");
    expect(markup).toContain(`attach`);
    expect(markup).toContain(`\\"draftId\\":${draft.id}`);
    expect(markup).toContain(`\\"draftId\\":${second.id}`);
    expect(markup).toContain("attach_cancel");
  });

  it("[REQ-034] 메모를 붙이면 그 초안의 경험 한 줄이 되고 다시 보내면 교체된다 (다른 초안은 그대로)", async () => {
    const { say, tap, db, draft, secondDraft } = setup();
    const second = secondDraft();
    await say("첫 메모");
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    expect(getDraft(db, draft.id)).toMatchObject({ body: { experienceLine: "첫 메모" }, quality: { hasExperienceLine: true } });
    expect(getDraft(db, second.id)?.body).toMatchObject({ experienceLine: null });

    await say("고친 메모");
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    expect(getDraft(db, draft.id)?.body).toMatchObject({ experienceLine: "고친 메모" });
  });

  it("[REQ-034] 사진을 붙이면 카드가 '내 한 컷 있음'으로 다시 오고, 다시 보내면 교체되며 이전 파일이 지워진다", async () => {
    const { sendPhoto, tap, db, draft, disk, sent } = setup();
    await sendPhoto();
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    const first = getDraft(db, draft.id)?.photo?.filePath;
    expect(first).toBeDefined();
    expect(sent().at(-1)).toContain("내 한 컷 있음");

    await sendPhoto();
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    const second = getDraft(db, draft.id)?.photo?.filePath;
    expect(second).not.toBe(first);
    expect([...disk.keys()]).toEqual([second]);
  });

  it("[REQ-034] 사진을 연달아 보내면 마지막 것만 남는다(EDGE-013)", async () => {
    const { sendPhoto, tap, db, draft, disk } = setup();
    await sendPhoto();
    await sendPhoto();
    expect(disk.size).toBe(1);
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    expect(getDraft(db, draft.id)?.photo).toMatchObject({ mime: "image/jpeg", bytes: 1000 });
  });

  it("[REQ-034] 취소 버튼은 대기 중인 사진을 버린다", async () => {
    const { sendPhoto, tap, disk, draft, db } = setup();
    await sendPhoto();
    await tap(JSON.stringify({ action: "attach_cancel" }));
    expect(disk.size).toBe(0);
    await tap(JSON.stringify({ action: "attach", draftId: draft.id })); // 대기가 없으니 붙지 않는다
    expect(getDraft(db, draft.id)?.photo ?? null).toBeNull();
  });

  it("[REQ-034] 붙일 대기 초안이 없으면 안내만 하고 파일을 저장하지 않는다 (EDGE-014: 폐기된 초안은 목록에 안 나온다)", async () => {
    const { sendPhoto, say, tap, draft, disk, sent } = setup();
    await tap(JSON.stringify({ action: "discard", draftId: draft.id }));
    await sendPhoto();
    await say("메모");
    expect(disk.size).toBe(0);
    expect(sent().filter((text) => text.includes("붙일 초안이 없어요"))).toHaveLength(2);
  });

  it("[REQ-034] 선택하는 사이 폐기된 초안에는 붙지 않고 남은 초안을 다시 묻는다", async () => {
    const { sendPhoto, tap, draft, secondDraft, db, sent } = setup();
    const second = secondDraft();
    await sendPhoto();
    await tap(JSON.stringify({ action: "discard", draftId: draft.id }));
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    expect(getDraft(db, draft.id)?.photo ?? null).toBeNull();
    expect(sent().at(-2)).toContain("이미 처리");
    await tap(JSON.stringify({ action: "attach", draftId: second.id }));
    expect(getDraft(db, second.id)?.photo).not.toBeNull();
  });

  it("[REQ-034] 파일(document)로 보낸 사진은 안내 후 거절한다 (EDGE-018)", async () => {
    const { sendDocument, sent, disk } = setup();
    await sendDocument("image/heic");
    expect(sent().at(-1)).toContain("파일");
    expect(disk.size).toBe(0);
  });

  it("[REQ-034] 폐기하면 사진 파일도 삭제된다 (EDGE-017)", async () => {
    const { sendPhoto, tap, draft, disk } = setup();
    await sendPhoto();
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    expect(disk.size).toBe(1);
    await tap(JSON.stringify({ action: "discard", draftId: draft.id }));
    expect(disk.size).toBe(0);
  });

  it("[REQ-034] `수정`으로 다시 만들어도 사진과 붙인 메모가 유지된다 (EDGE-015)", async () => {
    const { say, sendPhoto, tap, draft, db } = setup();
    await sendPhoto();
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    await say("직접 쓴 메모");
    await tap(JSON.stringify({ action: "attach", draftId: draft.id }));
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    await say("표를 더 간단히");
    expect(getDraft(db, draft.id)).toMatchObject({ status: "awaiting_approval", body: { experienceLine: "직접 쓴 메모" } });
    expect(getDraft(db, draft.id)?.photo).toBeTruthy();
  });

  it("[REQ-034] 수정 대기 중의 일반 텍스트는 메모가 아니라 수정 지시다 (입력 분기 ①)", async () => {
    const { tap, say, draft, generator } = setup();
    await tap(JSON.stringify({ action: "revise", draftId: draft.id }));
    await say("표를 더 간단히");
    expect(vi.mocked(generator.generateBody)).toHaveBeenCalledTimes(1);
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
