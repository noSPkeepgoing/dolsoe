import type Database from "better-sqlite3";

import { claimDueJobs, enqueueJob, getKv, setKv } from "../db.js";

import { kstDateString, nextDailyDueAt, planStartup } from "./time.js";

export const LAST_DAILY_ATTEMPT_KEY = "last_daily_attempt_date";

/**
 * ADR-002: DB `due_at`을 tick마다 확인해 일일 작업을 실행한다.
 * 기동 시(start)에는 꺼져 있던 동안 쌓인 묵은 잡을 실행하지 않고 폐기한 뒤, 오늘치 1편만 만들고 누락 일수는 알린다(EDGE-006).
 */
export function createScheduler(deps: {
  db: Database.Database;
  now: () => Date;
  runDailyDraft: () => Promise<unknown>;
  notify: (text: string) => Promise<void>;
}): { start(): Promise<void>; tick(): Promise<void> } {
  const { db, now, runDailyDraft, notify } = deps;

  const safeNotify = async (text: string): Promise<void> => {
    try {
      await notify(text);
    } catch (error) {
      console.error("[scheduler] notify failed", error); // 알림 실패가 스케줄러를 죽이면 안 된다
    }
  };

  const ensureNextJob = (): void => {
    enqueueJob(db, "daily_draft", nextDailyDueAt(now()));
  };

  // 시도 기록을 먼저 남긴다: 작업 중 죽어도 재기동 때 같은 날 또 만들지 않는다(알림 폭주 방지).
  const runDaily = async (): Promise<void> => {
    setKv(db, LAST_DAILY_ATTEMPT_KEY, kstDateString(now()));
    try {
      await runDailyDraft();
    } catch (error) {
      console.error("[scheduler] daily draft failed", error);
      const message = error instanceof Error ? error.message : String(error);
      await safeNotify(`오늘의 초안 작업이 실패했어요: ${message}`);
    }
  };

  return {
    async start() {
      const plan = planStartup({ now: now(), lastAttemptKstDate: getKv(db, LAST_DAILY_ATTEMPT_KEY) });
      claimDueJobs(db, now()); // 꺼져 있던 동안 밀린 잡은 실행하지 않고 버린다
      ensureNextJob();
      if (plan.missedDays > 0) {
        await safeNotify(`봇이 꺼져 있던 날이 ${plan.missedDays}일 있었어요. 밀린 글은 만들지 않고 오늘부터 다시 시작해요.`);
      }
      if (plan.generateToday) await runDaily();
    },

    async tick() {
      const jobs = claimDueJobs(db, now());
      for (const job of jobs) {
        if (job.kind === "daily_draft") await runDaily();
      }
      if (jobs.length > 0) ensureNextJob();
    },
  };
}
