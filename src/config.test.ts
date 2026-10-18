import { describe, expect, it } from "vitest";

import { loadConfig, requireDailyDraftKeys } from "./config.js";

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

  it("[REQ-012] NAVER_PROFILE_DIR는 선택이다 — 없으면 네이버 임시저장 단계 없이 텔레그램 전달만 쓴다", () => {
    expect(loadConfig(VALID_ENV).NAVER_PROFILE_DIR).toBeUndefined();
    expect(loadConfig({ ...VALID_ENV, NAVER_PROFILE_DIR: "data/naver-profile" }).NAVER_PROFILE_DIR).toBe("data/naver-profile");
  });

  it("[NFR-003] 봇 토큰이 없으면 어떤 키가 문제인지 알려주며 실패한다", () => {
    expect(() => loadConfig({ OWNER_CHAT_ID: "1" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("[REQ-014] 소유자 chat_id가 없거나 숫자가 아니면 실패한다(소유자 없이 기동 금지)", () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t" })).toThrow(/OWNER_CHAT_ID/);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", OWNER_CHAT_ID: "abc" })).toThrow(/OWNER_CHAT_ID/);
  });
});

describe("requireDailyDraftKeys", () => {
  it("[NFR-003] 일일 초안에 필요한 키가 모두 있으면 값을 돌려준다", () => {
    const config = loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: "sk-ant-x", YES24_API_KEY: "yk_x" });
    expect(requireDailyDraftKeys(config)).toEqual({ anthropicApiKey: "sk-ant-x", yes24ApiKey: "yk_x" });
  });

  it("[NFR-003] 없는 키 이름을 모두 알려주며 실패한다(조용히 기능을 끄지 않는다)", () => {
    const config = loadConfig(VALID_ENV);
    expect(() => requireDailyDraftKeys(config)).toThrow(/ANTHROPIC_API_KEY.*YES24_API_KEY/);
    const onlyYes24Missing = loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: "k" });
    expect(() => requireDailyDraftKeys(onlyYes24Missing)).toThrow(/YES24_API_KEY/);
  });
});
