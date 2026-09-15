/*
 * 真实浏览器验证脚本（Playwright + Chromium）。
 * 启动本地静态服务器，分别在桌面与手机视口跑关键流程，结果写入 verify-results.json。
 * 运行：npm run verify:browser
 */
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8931;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, urlPath === "/" ? "/planner.html" : urlPath);
    if (!file.startsWith(ROOT)) throw new Error("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function chipLayout(page) {
  return page.$$eval("#diagram .slot", slots =>
    slots.map(s => `${s.dataset.slotId}:${[...s.querySelectorAll(".chip")].map(c => c.dataset.boxCode).join("+")}`)
      .join("|"));
}
async function diagramText(page) { return (await page.textContent("#diagram")).replace(/\s+/g, " ").trim(); }
async function handoverText(page) { return (await page.textContent("#handoverList")).replace(/\s+/g, " ").trim(); }
async function statusText(page) { return (await page.textContent("#statusBadge")).trim(); }

const browser = await chromium.launch();
const pageErrors = [];

try {
  await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));

  /* ---------- 桌面视口 ---------- */
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const d = await desktop.newPage();
  d.on("pageerror", e => pageErrors.push("desktop: " + e.message));
  await d.goto(`http://127.0.0.1:${PORT}/planner.html`);
  await d.waitForSelector("#diagram .chip");

  const chipCount = await d.locator("#diagram .chip").count();
  record("桌面：首次加载渲染已提交装载图", chipCount === 6, `chips=${chipCount}`);
  record("桌面：状态徽标为已提交", (await statusText(d)) === "已提交");
  const ports = await d.locator("#handoverList .handover-port").count();
  record("桌面：交接明细按港序分组渲染", ports === 3, `ports=${ports}`);

  // 确定性（界面层）：生成 → 放弃 → 再生成，布局一致
  await d.click("#btnGenerate");
  record("桌面：自动生成后进入预览待确认", (await statusText(d)) === "预览待确认");
  const layoutA = await chipLayout(d);
  await d.click("#btnDiscard");
  await d.click("#btnGenerate");
  const layoutB = await chipLayout(d);
  record("桌面：重复生成方案一致（确定性）", layoutA === layoutB);

  // 确认保存 + 刷新后持久化
  const handoverBefore = await handoverText(d);
  await d.click("#btnCommit");
  record("桌面：确认保存后回到已提交", (await statusText(d)) === "已提交");
  await d.reload();
  await d.waitForSelector("#diagram .chip");
  record("桌面：刷新后方案持久化", (await chipLayout(d)) === layoutA && (await handoverText(d)) === handoverBefore);

  // 手动调整：点箱 chip → 点目标舱位 → 确认保存
  await d.click('.chip[data-box-code="BX-104"]');
  await d.click('.slot[data-slot-id="D2-R1C1"]');
  record("桌面：手动移动箱后进入预览", (await statusText(d)) === "预览待确认");
  await d.click("#btnCommit");
  const movedLayout = await chipLayout(d);
  record("桌面：移动已保存且交接明细更新",
    movedLayout.includes("D2-R1C1:BX-104") && (await handoverText(d)).includes("D2-R1C1"));

  // 冲突路径：把 BX-101 重量改为 5000kg（超过所有舱位承重）→ 重算失败
  // 回归点：①已提交的装载图/约束结果/交接明细完整保留，重量与舱位现重不得显示草稿值
  //         ②冲突说明必须是真实失败约束（舱位承重），不能只报笼统“无法安置”
  const handoverCommitted = await handoverText(d);
  const layoutCommitted = await chipLayout(d);
  const diagramCommitted = await diagramText(d);
  await d.click('#boxList .box-item[data-code="BX-101"]');
  await d.fill('input[name="weight"]', "5000");
  await d.click('#boxForm button[type="submit"]');
  const conflictVisible = await d.locator("#conflictPanel .conflict-item").first().isVisible();
  const conflictText = (await d.textContent("#conflictPanel")).replace(/\s+/g, " ");
  record("桌面：失败冲突报告真实约束（箱号+舱位承重），非笼统无法安置",
    conflictVisible && conflictText.includes("BX-101") && conflictText.includes("舱位承重") &&
    !/BX-101 · 无法安置/.test(conflictText), conflictText.slice(0, 90));
  record("桌面：失败后已提交约束结果仍展示",
    conflictText.includes("已提交方案约束结果"));
  record("桌面：冲突时状态为未保存且确认按钮禁用",
    (await statusText(d)).includes("未保存") && await d.locator("#btnCommit").isDisabled());
  record("桌面：失败时装载图不变（布局）", (await chipLayout(d)) === layoutCommitted);
  const diagramAfterFail = await diagramText(d);
  record("桌面：失败后箱重/舱位现重仍为已提交值，不混草稿值",
    diagramAfterFail === diagramCommitted && !diagramAfterFail.includes("5000"),
    diagramAfterFail.includes("5000") ? "装载图出现了草稿重量 5000" : "");
  record("桌面：失败时交接明细不变", (await handoverText(d)) === handoverCommitted);

  // 放弃草稿恢复；再做一次合法变更走完整保存链路
  await d.click("#btnDiscard");
  record("桌面：放弃草稿后恢复已提交状态", (await statusText(d)) === "已提交" && (await chipLayout(d)) === layoutCommitted);
  await d.click('#boxList .box-item[data-code="BX-106"]');
  await d.fill('input[name="weight"]', "250");
  await d.click('#boxForm button[type="submit"]');
  record("桌面：合法箱体变更自动重算为预览", (await statusText(d)) === "预览待确认");
  await d.click("#btnCommit");
  await d.reload();
  await d.waitForSelector("#diagram .chip");
  record("桌面：合法变更保存并持久化", (await handoverText(d)).includes("250kg") && (await statusText(d)) === "已提交");

  // 舱位变更触发重算：展开设置面板，把 D1-R1C1 堆叠上限调为 1
  await d.click("details summary");
  await d.selectOption("#slotSelect", "D1-R1C1");
  await d.fill("#slotMaxStack", "1");
  await d.click("#btnApplySlot");
  const st = await statusText(d);
  record("桌面：舱位变更后自动重算（预览或冲突）", st === "预览待确认" || st.includes("未保存"), st);

  // 入口互链
  await d.goto(`http://127.0.0.1:${PORT}/index.html`);
  await d.click('a[href="planner.html"]');
  await d.waitForSelector("#diagram");
  record("桌面：index.html 入口可进入规划台", d.url().includes("planner.html"));
  await d.click('a[href="index.html"]');
  record("桌面：规划台可返回潜水记录", d.url().includes("index.html"));
  await desktop.close();

  /* ---------- 手机视口 ---------- */
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const m = await mobile.newPage();
  m.on("pageerror", e => pageErrors.push("mobile: " + e.message));
  await m.goto(`http://127.0.0.1:${PORT}/planner.html`);
  await m.waitForSelector("#diagram .chip");

  const singleColumn = await m.evaluate(() => {
    const main = document.querySelector(".layout");
    return getComputedStyle(main).gridTemplateColumns.split(" ").length === 1;
  });
  record("手机：布局为单列", singleColumn);
  record("手机：装载图与交接明细可见",
    await m.locator("#diagram").isVisible() && await m.locator("#handoverList").isVisible());

  await m.tap("#btnGenerate");
  record("手机：触屏可生成方案", (await statusText(m)) === "预览待确认");
  await m.tap("#btnCommit");
  record("手机：触屏可确认保存", (await statusText(m)) === "已提交");
  await m.reload();
  await m.waitForSelector("#diagram .chip");
  record("手机：刷新后方案持久化", (await m.locator("#diagram .chip").count()) === 6);

  // 手机上手动移动一个箱
  await m.tap('.chip[data-box-code="BX-105"]');
  await m.tap('.slot[data-slot-id="D2-R2C3"]');
  const mStatus = await statusText(m);
  record("手机：触屏可调整装载", mStatus === "预览待确认" || mStatus.includes("未保存"), mStatus);
  await m.tap("#btnCommit");

  // 手机上的失败重算回归：超限重量不得混入装载图，冲突须为真实约束
  const mDiagramCommitted = await diagramText(m);
  const mHandoverCommitted = await handoverText(m);
  await m.tap('#boxList .box-item[data-code="BX-101"]');
  await m.fill('input[name="weight"]', "5000");
  await m.tap('#boxForm button[type="submit"]');
  const mConflictText = (await m.textContent("#conflictPanel")).replace(/\s+/g, " ");
  record("手机：失败冲突报告真实约束（舱位承重）",
    mConflictText.includes("BX-101") && mConflictText.includes("舱位承重"));
  const mDiagramAfter = await diagramText(m);
  record("手机：失败后装载图/交接明细保持已提交值",
    mDiagramAfter === mDiagramCommitted && !mDiagramAfter.includes("5000") &&
    (await handoverText(m)) === mHandoverCommitted);
  await m.tap("#btnDiscard");
  record("手机：放弃草稿后恢复已提交", (await statusText(m)) === "已提交");
  await mobile.close();

  record("浏览器控制台无未捕获异常", pageErrors.length === 0, pageErrors.join("; "));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(r => r.ok).length;
const summary = {
  at: new Date().toISOString(),
  browser: "Chromium 153.0.8010.12 (playwright headless)",
  viewports: ["desktop 1280x800", "mobile 390x844 (iPhone UA, touch)"],
  total: results.length, passed, failed: results.length - passed,
  results
};
await writeFile(path.join(ROOT, "verify-results.json"), JSON.stringify(summary, null, 2));
console.log(`\n${passed}/${results.length} 项通过`);
process.exit(results.every(r => r.ok) ? 0 : 1);
