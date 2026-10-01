import "dotenv/config";

import { Bot } from "grammy";

import { ownerOnly } from "./bot/owner-only.js";
import { loadConfig } from "./config.js";
import { markUpdateProcessed, openDb } from "./db.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.DB_PATH);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.use(ownerOnly(config.OWNER_CHAT_ID, { markProcessed: (id) => markUpdateProcessed(db, id, new Date()) }));

  // 생존 확인용. 실제 기능 핸들러는 1.2~1.3에서 추가한다.
  bot.command("ping", (ctx) => ctx.reply("pong"));

  bot.catch((error) => {
    console.error("[bot] unhandled error", error.error);
  });

  const shutdown = async (): Promise<void> => {
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log("[dolsoe] starting (long polling)");
  await bot.start();
}

main().catch((error) => {
  console.error("[dolsoe] fatal", error);
  process.exit(1);
});
