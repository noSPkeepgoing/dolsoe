import { DAILY_DRAFT_HOUR_KST } from "@contract/domain.js";

/** NFR-002: 모든 "하루"는 KST(UTC+9, 서머타임 없음) 기준이다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const toKst = (instant: Date): Date => new Date(instant.getTime() + KST_OFFSET_MS);

export function kstDateString(now: Date): string {
  return toKst(now).toISOString().slice(0, 10);
}

export function kstMonth(now: Date): string {
  return toKst(now).toISOString().slice(0, 7);
}

/** REQ-001: now보다 항상 뒤인, 다음 KST 08:00(`DAILY_DRAFT_HOUR_KST`). 정각이면 내일. */
export function nextDailyDueAt(now: Date): Date {
  const kst = toKst(now);
  const todayDue = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), DAILY_DRAFT_HOUR_KST) - KST_OFFSET_MS;
  return new Date(todayDue > now.getTime() ? todayDue : todayDue + DAY_MS);
}

const dateStringToDayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/**
 * EDGE-006: 기동 시 무엇을 할지. 오늘치(시각이 지났고 오늘 시도 기록이 없을 때)만 1편 만들고,
 * 놓친 날 수(마지막 시도일과 오늘 사이의 날)는 알리기만 한다 — 밀린 글을 몰아서 만들지 않는다.
 */
export function planStartup(input: { now: Date; lastAttemptKstDate: string | null }): {
  generateToday: boolean;
  missedDays: number;
} {
  const today = kstDateString(input.now);
  const pastDueHour = toKst(input.now).getUTCHours() >= DAILY_DRAFT_HOUR_KST;
  const last = input.lastAttemptKstDate;
  return {
    generateToday: pastDueHour && last !== today,
    missedDays: last === null ? 0 : Math.max(0, dateStringToDayNumber(today) - dateStringToDayNumber(last) - 1),
  };
}
