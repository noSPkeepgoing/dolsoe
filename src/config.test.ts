import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const VALID_ENV = { TELEGRAM_BOT_TOKEN: "123:abc", OWNER_CHAT_ID: "987654321" };

describe("loadConfig", () => {
  it("[NFR-003] 필수 env가 있으면 OWNER_CHAT_ID를 숫자로 변환하고 DB_PATH 기본값을 채운다", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(config.OWNER_CHAT_ID).toBe(987654321);
    expect(config.DB_PATH).toBe("data/dolsoe.db");
  });

  it("[NFR-003] DB_PATH를 env로 덮어쓸 수 있다", () => {
    expect(loadConfig({ ...VALID_ENV, DB_PATH: "/tmp/x.db" }).DB_PATH).toBe("/tmp/x.db");
  });

  it("[NFR-003] 봇 토큰이 없으면 어떤 키가 문제인지 알려주며 실패한다", () => {
    expect(() => loadConfig({ OWNER_CHAT_ID: "1" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("[REQ-014] 소유자 chat_id가 없거나 숫자가 아니면 실패한다(소유자 없이 기동 금지)", () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t" })).toThrow(/OWNER_CHAT_ID/);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", OWNER_CHAT_ID: "abc" })).toThrow(/OWNER_CHAT_ID/);
  });
});
