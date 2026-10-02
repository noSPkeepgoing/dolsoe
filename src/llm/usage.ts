import type Database from "better-sqlite3";

import { addLlmCostKrw } from "../db.js";
import { kstMonth } from "../schedule/time.js";

import type { LlmUsageReport } from "./body-generator.js";
import { estimateCostKrw } from "./cost.js";

/** NFR-001: 호출마다 추정 비용을 KST 월별로 누적한다. 상한 확인(isBudgetExceeded)은 일일 작업이 이 누적값으로 한다. */
export function recordLlmUsage(db: Database.Database, now: Date, usage: LlmUsageReport): void {
  addLlmCostKrw(
    db,
    kstMonth(now),
    estimateCostKrw(usage.model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    }),
  );
}
