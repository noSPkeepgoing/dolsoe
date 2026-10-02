import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";

import { TICK_INTERVAL_SECONDS } from "@contract/domain.js";

import { ownerOnly } from "./bot/owner-only.js";
import { loadConfig, requireDailyDraftKeys } from "./config.js";
import { markUpdateProcessed, openDb } from "./db.js";
import { createDraftStore } from "./draft/store.js";
import { runDailyDraft } from "./jobs/daily-draft.js";
import { createBodyGenerator } from "./llm/body-generator.js";
import { recordLlmUsage } from "./llm/usage.js";
import { createScheduler } from "./schedule/scheduler.js";
import { Yes24Source } from "./sources/yes24.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const keys = requireDailyDraftKeys(config);
  const db = openDb(config.DB_PATH);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const now = (): Date => new Date();

  bot.use(ownerOnly(config.OWNER_CHAT_ID, { markProcessed: (id) => markUpdateProcessed(db, id, now()) }));

  // 생존 확인용. 승인 버튼·링크 모드 핸들러는 1.3에서 추가한다.
  bot.command("ping", (ctx) => ctx.reply("pong"));

  bot.catch((error) => {
    console.error("[bot] unhandled error", error.error);
  });

  const notify = async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.OWNER_CHAT_ID, text);
  };

  const generator = createBodyGenerator({
    client: new Anthropic({ apiKey: keys.anthropicApiKey }),
    onUsage: (usage) => recordLlmUsage(db, now(), usage),
  });
  const sources = [new Yes24Source({ apiKey: keys.yes24ApiKey })];
  const store = createDraftStore(db, now);

  const scheduler = createScheduler({
    db,
    now,
    runDailyDraft: () => runDailyDraft({ now, sources, generator, store, notify }),
    notify,
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
