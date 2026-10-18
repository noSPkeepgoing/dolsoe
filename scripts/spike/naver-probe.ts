// 1.5 스파이크: 저장된 프로필로 글쓰기 화면을 열어 구조만 읽는다(글은 쓰지 않는다).
import { chromium } from "playwright";

const PROFILE = process.env.NAVER_PROFILE_DIR ?? "data/naver-profile";
const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://blog.naver.com/GoBlogWrite.naver", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log("URL:", page.url().replace(/(blogId=|\/)[A-Za-z0-9_-]{4,}(?=\/|\?|$)/g, "$1<id>"));
for (const f of page.frames()) console.log("frame:", f.name().slice(0, 30) || "(main)", f.url().slice(0, 90));
const w = page.frames().find((f) => f.url().includes("PostWriteForm")) ?? page.mainFrame();
const info = await w.evaluate(`(() => {
  const n = (s) => document.querySelectorAll(s).length;
  const btns = [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 40);
  return { title: n(".se-title-text, .se-documentTitle"), body: n(".se-component, .se-content"), contentEditable: n("[contenteditable=true]"), btns, popups: [...document.querySelectorAll("[class*=popup],[class*=layer],[class*=dialog]")].map((e) => e.className).slice(0, 10) };
})()`);
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: "data/naver-probe.png" });
await context.close();
