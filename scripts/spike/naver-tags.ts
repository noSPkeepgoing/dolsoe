// 1.7a 스파이크: ② 링크 카드 위치 ① 태그 입력 UI(발행 패널) 탐색. 저장·발행하지 않는다(headed 전용).
import "dotenv/config";
import { chromium } from "playwright";

const SCRATCH = process.env.SPIKE_OUT ?? ".";
const HTML = [
  `<p id="a">첫 문단</p>`,
  `<p id="b">링크 문장 <a href="https://www.yes24.com/">링크 텍스트</a> 뒤</p>`,
  `<p id="c">대가성 문구 자리 문단(마지막)</p>`,
].join("");

const context = await chromium.launchPersistentContext(process.env.NAVER_PROFILE_DIR ?? "data/naver-profile", { headless: process.env.SPIKE_HEADLESS === "1", viewport: { width: 1200, height: 1600 } });
try {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://blog.naver.com/GoBlogWrite.naver", { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 30_000;
  let editor = page.frames().find((f) => f.url().includes("PostWriteForm"));
  while (!editor && Date.now() < deadline) { await page.waitForTimeout(500); editor = page.frames().find((f) => f.url().includes("PostWriteForm")); }
  if (!editor) throw new Error("에디터 없음 url=" + page.url());
  await editor.locator(".se-title-text").first().waitFor({ timeout: 30_000 });
  const popup = editor.locator(".se-popup-alert-confirm").first();
  if (await popup.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) await editor.locator(".se-popup-alert-confirm .se-popup-button-cancel").first().click();
  await page.waitForTimeout(2000);
  await editor.locator(".se-title-text").first().click();
  await page.keyboard.type("[태그 스파이크] 지워도 되는 글");
  await editor.locator(".se-component.se-text .se-text-paragraph").first().click();
  await page.evaluate(async (html) => {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob(["x"], { type: "text/plain" }) })]);
  }, HTML);
  await page.keyboard.press("ControlOrMeta+V");
  await page.waitForTimeout(6000);
  const order = await editor.evaluate(() =>
    [...document.querySelectorAll(".se-main-container .se-component")].map((c) => `${c.className.replace(/\s+/g, " ").slice(0, 50)} | ${(c.textContent ?? "").trim().slice(0, 30)}`));
  console.log("컴포넌트 순서:\n" + order.join("\n"));
  // 발행 패널만 열어 태그 입력칸을 찾는다(발행 확정은 누르지 않음).
  const buttons = await editor.evaluate(() => [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter(Boolean));
  console.log("버튼:", JSON.stringify(buttons));
  await editor.getByRole("button", { name: "발행", exact: true }).first().click();
  await page.waitForTimeout(2000);
  const tagInfo = await editor.evaluate(() =>
    [...document.querySelectorAll("input,textarea")].map((i) => `${i.tagName}#${i.id}.${i.className.toString().slice(0, 40)} ph=${i.getAttribute("placeholder")}`));
  console.log("입력칸:\n" + tagInfo.join("\n"));
  await page.screenshot({ path: `${SCRATCH}/tags.png`, fullPage: true });
} finally {
  await context.close();
}
