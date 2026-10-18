import { z } from "zod";

/** env 스키마. 비밀값은 코드/저장소가 아니라 .env에서만 온다(NFR-003). 필요한 키는 해당 페이즈에서 추가한다. */
const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OWNER_CHAT_ID: z.coerce.number().int(), // REQ-014: 소유자 없이 기동하지 않는다
  DB_PATH: z.string().min(1).default("data/dolsoe.db"),
  // 1.2: 일일 초안에 필요. 스키마에서는 선택이지만 기동 시 requireDailyDraftKeys가 없으면 실패시킨다.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  YES24_API_KEY: z.string().min(1).optional(),
  // 1.5: 네이버 임시저장용 전용 브라우저 프로필 경로(ADR-005 개정). 없으면 임시저장 단계 없이 텔레그램 전달만 쓴다.
  NAVER_PROFILE_DIR: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment — ${problems.join("; ")}`);
  }
  return parsed.data;
}

/** 일일 초안에 필요한 키. 없으면 어떤 키인지 알리며 실패한다 — 조용히 기능을 끄지 않는다(NFR-004). */
export function requireDailyDraftKeys(config: Config): { anthropicApiKey: string; yes24ApiKey: string } {
  const missing = [
    config.ANTHROPIC_API_KEY === undefined ? "ANTHROPIC_API_KEY" : null,
    config.YES24_API_KEY === undefined ? "YES24_API_KEY" : null,
  ].filter((key): key is string => key !== null);
  if (config.ANTHROPIC_API_KEY === undefined || config.YES24_API_KEY === undefined) {
    throw new Error(`Missing required environment for daily drafts — ${missing.join(", ")}`);
  }
  return { anthropicApiKey: config.ANTHROPIC_API_KEY, yes24ApiKey: config.YES24_API_KEY };
}
