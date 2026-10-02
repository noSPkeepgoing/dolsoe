import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";

import { TICK_INTERVAL_SECONDS } from "@contract/domain.js";

import { registerHandlers } from "./bot/handlers.js";
import { ownerOnly } from "./bot/owner-only.js";
import { createMessenger } from "./bot/telegram.js";
import { loadConfig, requireDailyDraftKeys } from "./config.js";
import { markUpdateProcessed, openDb } from "./db.js";
import { recoverStuckDrafts } from "./draft/approval.js";
import { createApprovalStore, createDraftStore, createPublishStore } from "./draft/store.js";
import { runDailyDraft } from "./jobs/daily-draft.js";
import { createBodyGenerator } from "./llm/body-generator.js";
import { recordLlmUsage } from "./llm/usage.js";
import { createHandoffPublisher } from "./publish/handoff.js";
import { recoverStuckPublishing, type PublishDeps } from "./publish/orchestrator.js";
import { createScheduler } from "./schedule/scheduler.js";
import { Yes24Source } from "./sources/yes24.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const keys = requireDailyDraftKeys(config);
  const db = openDb(config.DB_PATH);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const now = (): Date => new Date();

  bot.use(ownerOnly(config.OWNER_CHAT_ID, { markProcessed: (id) => markUpdateProcessed(db, id, now()) }));

  // 생존 확인용. 명령은 아래 텍스트 핸들러(수정 지시·링크 모드)보다 먼저 등록해야 한다.
  bot.command("ping", (ctx) => ctx.reply("pong"));

  bot.catch((error) => {
    console.error("[bot] unhandled error", error.error);
  });

  const messenger = createMessenger(bot.api, config.OWNER_CHAT_ID);
  const generator = createBodyGenerator({
    client: new Anthropic({ apiKey: keys.anthropicApiKey }),
    onUsage: (usage) => recordLlmUsage(db, now(), usage),
  });
  const yes24 = new Yes24Source({ apiKey: keys.yes24ApiKey });
  const store = createDraftStore(db, now);

  const approvalStore = createApprovalStore(db, now);
  const approval = { store: approvalStore, generator, getMonthCostKrw: store.getMonthCostKrw, ...messenger };
  // 발행 사다리(ADR-005): 1차 구현은 ③ 텔레그램 전달만. 네이버 어댑터는 1.5 스파이크 뒤 위 단계로 추가한다.
  const publish: PublishDeps = {
    store: { ...approvalStore, ...createPublishStore(db, now) },
    publishers: [createHandoffPublisher({ sendChunk: messenger.sendChunk })],
    notify: messenger.notify,
    notifyFailure: messenger.notifyFailure,
  };
  registerHandlers(bot, {
    approval,
    publish,
    link: { now, generator, store, resolveYes24: (itemId) => yes24.fetchItem(itemId), ...messenger },
  });

  // 수정 중 재시작으로 멈춘 초안을 먼저 되돌린다(안 그러면 승인 대기 상한을 계속 차지한다).
  await recoverStuckDrafts(approval);
  await recoverStuckPublishing(publish);

  const scheduler = createScheduler({
    db,
    now,
    runDailyDraft: () => runDailyDraft({ now, sources: [yes24], generator, store, ...messenger }),
    notify: messenger.notify,
  });

  await scheduler.start();
  const timer = setInterval(() => {
    scheduler.tick().catch((error: unknown) => console.error("[scheduler] tick failed", error));
  }, TICK_INTERVAL_SECONDS * 1000);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log("[dolsoe] starting (long polling + scheduler)");
  await bot.start();
}

main().catch((error) => {
  console.error("[dolsoe] fatal", error);
  process.exit(1);
});
