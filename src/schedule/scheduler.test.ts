import { describe, expect, it, vi } from "vitest";

import { enqueueJob, getKv, openDb } from "../db.js";

import { LAST_DAILY_ATTEMPT_KEY, createScheduler } from "./scheduler.js";

const setup = (nowIso: string) => {
  const db = openDb(":memory:");
  let now = new Date(nowIso);
  const runDailyDraft = vi.fn(async () => {});
  const notify = vi.fn<(text: string) => Promise<void>>(async () => {});
  const scheduler = createScheduler({ db, now: () => now, runDailyDraft, notify });
  return { db, runDailyDraft, notify, scheduler, setNow: (iso: string) => { now = new Date(iso); } };
};

describe("createScheduler", () => {
  it("[REQ-001] 08:00 KST 전에는 돌지 않고, 시각이 되면 한 번만 돈다(같은 tick 반복해도 중복 없음)", async () => {
    const s = setup("2026-09-30T22:00:00Z"); // KST 07:00
    await s.scheduler.start();
    await s.scheduler.tick();
    expect(s.runDailyDraft).not.toHaveBeenCalled();

    s.setNow("2026-09-30T23:00:00Z"); // KST 08:00
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(s.runDailyDraft).toHaveBeenCalledTimes(1);
  });

  it("[REQ-001] 한 번 돈 뒤에는 다음 날 08:00 KST 잡이 예약되어 다음 날 다시 돈다", async () => {
    const s = setup("2026-09-30T22:00:00Z");
    await s.scheduler.start();
    s.setNow("2026-09-30T23:00:00Z");
    await s.scheduler.tick();
    s.setNow("2026-10-01T22:59:59Z"); // 다음 날 07:59:59 KST
    await s.scheduler.tick();
    expect(s.runDailyDraft).toHaveBeenCalledTimes(1);
    s.setNow("2026-10-01T23:00:00Z");
    await s.scheduler.tick();
    expect(s.runDailyDraft).toHaveBeenCalledTimes(2);
  });

  it("[NFR-002] 시도한 날은 KST 날짜로 기록한다", async () => {
    const s = setup("2026-09-30T22:00:00Z");
    await s.scheduler.start();
    s.setNow("2026-09-30T23:00:00Z"); // KST 2026-10-01 08:00 (UTC로는 아직 9/30)
    await s.scheduler.tick();
    expect(getKv(s.db, LAST_DAILY_ATTEMPT_KEY)).toBe("2026-10-01");
  });

  it("[EDGE-006] 며칠 꺼져 있다 켜지면 오늘치 1편만 만들고 누락 일수는 알린다(밀린 잡은 몰아서 돌리지 않음)", async () => {
    const s = setup("2026-10-01T01:00:00Z"); // KST 10:00
    // 꺼지기 전에 예약돼 있던 잡 + 마지막 시도 9/27
    enqueueJob(s.db, "daily_draft", new Date("2026-09-27T23:00:00Z"));
    s.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(LAST_DAILY_ATTEMPT_KEY, "2026-09-27");

    await s.scheduler.start();
    expect(s.runDailyDraft).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]![0]).toContain("3일");

    await s.scheduler.tick(); // 묵은 잡이 다시 돌면 안 된다
    expect(s.runDailyDraft).toHaveBeenCalledTimes(1);
  });

  it("[EDGE-006] 오늘 이미 시도했다면 재기동해도 다시 만들지 않고 누락 알림도 없다", async () => {
    const s = setup("2026-10-01T01:00:00Z");
    s.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(LAST_DAILY_ATTEMPT_KEY, "2026-10-01");
    await s.scheduler.start();
    expect(s.runDailyDraft).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("[REQ-005] 일일 작업이 예외로 죽어도 스케줄러는 계속 살아 알리고, 다음 날 잡을 예약한다", async () => {
    const s = setup("2026-09-30T22:00:00Z");
    s.runDailyDraft.mockRejectedValueOnce(new Error("boom"));
    await s.scheduler.start();
    s.setNow("2026-09-30T23:00:00Z");
    await s.scheduler.tick();
    expect(s.notify.mock.calls.some((call) => String(call[0]).includes("boom"))).toBe(true);
    s.setNow("2026-10-01T23:00:00Z");
    await s.scheduler.tick();
    expect(s.runDailyDraft).toHaveBeenCalledTimes(2);
  });
});
