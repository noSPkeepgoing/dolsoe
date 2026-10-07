import { describe, expect, it } from "vitest";

import { USD_TO_KRW, WEB_SEARCH_USD_PER_REQUEST } from "@contract/domain.js";

import { getMonthLlmCostKrw, openDb } from "../db.js";

import { recordLlmUsage } from "./usage.js";

describe("recordLlmUsage", () => {
  it("[NFR-001] 사용량을 추정 원화로 바꿔 KST 월별로 누적한다", () => {
    const db = openDb(":memory:");
    const now = new Date("2026-09-30T15:00:00Z"); // KST 2026-10
    recordLlmUsage(db, now, { model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 });
    recordLlmUsage(db, now, { model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 });
    expect(getMonthLlmCostKrw(db, "2026-10")).toBeCloseTo(2 * 2 * USD_TO_KRW);
    expect(getMonthLlmCostKrw(db, "2026-09")).toBe(0);
  });

  it("[NFR-001][REQ-016] 웹검색 횟수도 같은 월 누적에 더한다", () => {
    const db = openDb(":memory:");
    const now = new Date("2026-09-30T15:00:00Z");
    recordLlmUsage(db, now, { model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearchRequests: 2 });
    expect(getMonthLlmCostKrw(db, "2026-10")).toBeCloseTo(2 * WEB_SEARCH_USD_PER_REQUEST * USD_TO_KRW);
  });
});
