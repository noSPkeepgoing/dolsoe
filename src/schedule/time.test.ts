import { describe, expect, it } from "vitest";

import { kstDateString, kstMonth, nextDailyDueAt, planStartup } from "./time.js";

describe("kstDateString / kstMonth", () => {
  it("[NFR-002] UTC 자정 직전이라도 KST 날짜로 센다(UTC 15:00 이후는 다음 날)", () => {
    expect(kstDateString(new Date("2026-09-30T14:59:59Z"))).toBe("2026-09-30");
    expect(kstDateString(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10-01");
  });

  it("[NFR-002] 월 경계도 KST 기준(비용 집계 월)", () => {
    expect(kstMonth(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10");
    expect(kstMonth(new Date("2026-09-30T14:59:59Z"))).toBe("2026-09");
  });
});

describe("nextDailyDueAt", () => {
  it("[REQ-001] 오늘 08:00 KST 전이면 오늘 08:00 KST", () => {
    // KST 2026-10-01 07:59:59 → 같은 날 08:00 KST = 2026-09-30T23:00:00Z
    expect(nextDailyDueAt(new Date("2026-09-30T22:59:59Z")).toISOString()).toBe("2026-09-30T23:00:00.000Z");
  });

  it("[REQ-001] 정확히 08:00 이거나 지났으면 내일 08:00 KST(항상 now보다 뒤)", () => {
    expect(nextDailyDueAt(new Date("2026-09-30T23:00:00Z")).toISOString()).toBe("2026-10-01T23:00:00.000Z");
    expect(nextDailyDueAt(new Date("2026-10-01T05:00:00Z")).toISOString()).toBe("2026-10-01T23:00:00.000Z");
  });
});

describe("planStartup", () => {
  const AFTER_8 = new Date("2026-10-01T01:00:00Z"); // KST 2026-10-01 10:00
  const BEFORE_8 = new Date("2026-09-30T20:00:00Z"); // KST 2026-10-01 05:00

  it("[EDGE-006] 며칠 꺼져 있었으면 오늘치 1편만 만들고 누락 일수는 알린다(몰아서 생성 금지)", () => {
    expect(planStartup({ now: AFTER_8, lastAttemptKstDate: "2026-09-27" })).toEqual({
      generateToday: true,
      missedDays: 3, // 9/28, 9/29, 9/30
    });
  });

  it("[EDGE-006] 오늘 이미 시도했으면 다시 만들지 않는다(재기동 반복으로 중복·알림 폭주 방지)", () => {
    expect(planStartup({ now: AFTER_8, lastAttemptKstDate: "2026-10-01" })).toEqual({
      generateToday: false,
      missedDays: 0,
    });
  });

  it("[EDGE-006] 08:00 전에 켜지면 오늘치는 정시 스케줄에 맡기고, 어제까지 누락만 알린다", () => {
    expect(planStartup({ now: BEFORE_8, lastAttemptKstDate: "2026-09-28" })).toEqual({
      generateToday: false,
      missedDays: 2, // 9/29, 9/30
    });
  });

  it("[REQ-001] 첫 실행(시도 기록 없음)은 08:00 이후면 오늘치를 만들고 누락 알림은 없다", () => {
    expect(planStartup({ now: AFTER_8, lastAttemptKstDate: null })).toEqual({ generateToday: true, missedDays: 0 });
  });

  it("[EDGE-006] 어제 시도했으면 누락 0", () => {
    expect(planStartup({ now: AFTER_8, lastAttemptKstDate: "2026-09-30" }).missedDays).toBe(0);
  });
});
