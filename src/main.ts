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
import { sweepMedia, type MediaDeps } from "./draft/media.js";
import { createMediaFiles, createTelegramDownloader } from "./draft/media-files.js";
import { createApprovalStore, createDraftStore, createMediaStore, createPublishStore } from "./draft/store.js";
import { runDailyDraft } from "./jobs/daily-draft.js";
import { createBodyGenerator } from "./llm/body-generator.js";
import { createQuoteCollector } from "./llm/quote-collector.js";
import { createReviewCollector } from "./llm/review-collector.js";
import { createSpecCollector } from "./llm/spec-collector.js";
import { recordLlmUsage } from "./llm/usage.js";
import { createHandoffPublisher } from "./publish/handoff.js";
import { createNaverDraftPublisher } from "./publish/naver.js";
import { createPlaywrightNaverDriver } from "./publish/naver-playwright.js";
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
  const anthropic = new Anthropic({ apiKey: keys.anthropicApiKey });
  const onUsage = (usage: Parameters<typeof recordLlmUsage>[2]): void => recordLlmUsage(db, now(), usage);
  const generator = createBodyGenerator({ client: anthropic, onUsage });
  // REQ-016: 책 후기 수집(웹검색). 실패해도 초안은 "후기 근거 없음"으로 계속 만든다.
  const reviewCollector = createReviewCollector({ client: anthropic, onUsage });
  const onReviewFailure = (reason: string): void => console.warn(`[review] ${reason}`);
  // REQ-028: 가전 스펙 수집(링크 모드). 실패해도 초안은 스펙 없이 계속 만든다.
  const specCollector = createSpecCollector({ client: anthropic, onUsage });
  const onSpecFailure = (reason: string): void => console.warn(`[spec] ${reason}`);
  // REQ-029: 책 필사 문구 수집(웹 2곳 교차 확인). 실패해도 초안은 소개문·없음으로 계속 만든다.
  const quoteCollector = createQuoteCollector({ client: anthropic, onUsage });
  const onQuoteFailure = (reason: string): void => console.warn(`[quote] ${reason}`);
  const yes24 = new Yes24Source({ apiKey: keys.yes24ApiKey });
  const store = createDraftStore(db, now);

  const approvalStore = createApprovalStore(db, now);
  const approval = { store: approvalStore, generator, getMonthCostKrw: store.getMonthCostKrw, ...messenger };
  // 발행 사다리(ADR-005 개정): NAVER_PROFILE_DIR가 있으면 ③ 네이버 임시저장 → ④ 텔레그램 전달, 없으면 ④만.
  const naverDraft =
    config.NAVER_PROFILE_DIR === undefined ? [] : [createNaverDraftPublisher({ driver: createPlaywrightNaverDriver({ profileDir: config.NAVER_PROFILE_DIR }) })];
  const publish: PublishDeps = {
    store: { ...approvalStore, ...createPublishStore(db, now) },
    publishers: [...naverDraft, createHandoffPublisher({ sendChunk: messenger.sendChunk, sendPhoto: messenger.sendPhoto })],
    notify: messenger.notify,
    notifyFailure: messenger.notifyFailure,
  };
  const media: MediaDeps = {
    store: createMediaStore(db, now),
    files: createMediaFiles(config.MEDIA_DIR),
    notify: messenger.notify,
    askAttach: messenger.askAttach,
    deliverCard: messenger.deliverCard,
  };
  registerHandlers(bot, {
    approval,
    media,
    downloadFile: createTelegramDownloader(bot.api, config.TELEGRAM_BOT_TOKEN),
    publish,
    link: { now, generator, store, resolveYes24: (itemId) => yes24.fetchItem(itemId), reviewCollector, onReviewFailure, quoteCollector, onQuoteFailure, specCollector, onSpecFailure, ...messenger },
  });

  // 수정 중 재시작으로 멈춘 초안을 먼저 되돌린다(안 그러면 승인 대기 상한을 계속 차지한다).
  await recoverStuckDrafts(approval);
  await recoverStuckPublishing(publish);
  await sweepMedia(media); // 종료된 초안의 사진·고아 파일 정리(REQ-034)

  const scheduler = createScheduler({
    db,
    now,
    runDailyDraft: () => runDailyDraft({ now, sources: [yes24], generator, store, reviewCollector, onReviewFailure, quoteCollector, onQuoteFailure, ...messenger }),
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
