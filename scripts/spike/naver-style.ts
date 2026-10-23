// 글 스타일 스파이크: 붙여넣은 HTML 서식이 네이버 에디터에서 어디까지 유지되는지 실측한다. 저장하지 않는다.
import "dotenv/config";
import { chromium } from "playwright";

const SCRATCH = process.env.SPIKE_OUT ?? ".";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC";
const HTML = [
  `<h2 id="p-h2">H2 소제목</h2>`,
  `<h3 id="p-h3">H3 소제목</h3>`,
  `<p id="p-size24"><span style="font-size:24px">크기24 글자</span></p>`,
  `<p id="p-size13"><span style="font-size:13px">크기13 글자</span></p>`,
  `<p id="p-color"><span style="color:#e8590c">주황 글자</span> <span style="color:#1c7ed6">파랑 글자</span></p>`,
  `<p id="p-bg"><span style="background-color:#fff3bf">노란 형광펜</span></p>`,
  `<p id="p-bold"><b>굵게</b> <i>기울임</i> <u>밑줄</u> <s>취소선</s></p>`,
  `<p id="p-center" style="text-align:center">가운데 정렬</p>`,
  `<blockquote id="p-quote">인용구 블록</blockquote>`,
  `<hr id="p-hr">`,
  `<p id="p-emoji">😀 📚 ✨ 이모지 문단</p>`,
  `<ul id="p-ul"><li>목록 하나</li><li>목록 둘</li></ul>`,
  `<table id="p-table" border="1" style="border-collapse:collapse"><tr><th style="background-color:#e7f5ff">제품</th><th>가격</th></tr><tr><td>A</td><td>30만원</td></tr></table>`,
  `<p id="p-link"><a href="https://www.yes24.com/">링크 텍스트</a></p>`,
  `<p id="p-imgdata"><img src="${PNG}" alt="데이터URI"></p>`,
  `<p id="p-imgurl"><img src="https://www.gstatic.com/webp/gallery/1.jpg" width="200" alt="외부URL"></p>`,
  `<p id="p-end">끝 문단</p>`,
].join("");

const context = await chromium.launchPersistentContext(process.env.NAVER_PROFILE_DIR ?? "data/naver-profile", { headless: false, viewport: { width: 1200, height: 1600 } });
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
  await page.keyboard.type("[스타일 스파이크] 지워도 되는 글");
  await editor.locator(".se-component.se-text .se-text-paragraph").first().click();
  await page.evaluate(async (html) => {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob(["x"], { type: "text/plain" }) })]);
  }, HTML);
  await page.keyboard.press("ControlOrMeta+V");
  await page.waitForTimeout(6000);
  const report = await editor.evaluate(() => {
    const root = document.querySelector(".se-main-container") ?? document.body;
    const comps = [...root.querySelectorAll(".se-component")].map((c) => ({
      cls: c.className.replace(/\s+/g, " ").slice(0, 80),
      text: (c.textContent ?? "").trim().slice(0, 40),
      html: c.innerHTML.replace(/\s+/g, " ").slice(0, 700),
    }));
    return { comps, imgs: [...root.querySelectorAll("img")].map((i) => i.getAttribute("src")?.slice(0, 80)) };
  });
  const fs = await import("node:fs");
  fs.writeFileSync(`${SCRATCH}/style-report.json`, JSON.stringify(report, null, 1));
  await page.screenshot({ path: `${SCRATCH}/style.png`, fullPage: true });
  console.log("components:", report.comps.length, "imgs:", JSON.stringify(report.imgs));
} finally {
  await context.close();
}
