import { z } from "zod";

/** env 스키마. 비밀값은 코드/저장소가 아니라 .env에서만 온다(NFR-003). 필요한 키는 해당 페이즈에서 추가한다. */
const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OWNER_CHAT_ID: z.coerce.number().int(), // REQ-014: 소유자 없이 기동하지 않는다
  DB_PATH: z.string().min(1).default("data/dolsoe.db"),
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
