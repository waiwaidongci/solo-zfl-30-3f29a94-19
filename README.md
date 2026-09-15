# 水下考古潜水记录 + 出水文物转运装载规划台

零依赖离线单页应用，直接双击打开 HTML 即可使用，数据保存在浏览器 localStorage。

## 页面

- `index.html` — 潜水记录：点击沉船平面图添加标记，支持筛选、编辑、删除、时间线和导出 JSON。
- `planner.html` — **转运装载规划台**（本次新增）：登记转运箱与货舱，自动生成/校验/确认装载方案，冲突时指明箱号与约束并拒绝保存。桌面与手机均可查看、调整、确认。

## 代码结构（数据层与界面分离）

```
index.html            潜水记录页（原有）
planner.html          规划台页面（界面壳）
src/planner-core.js   数据层：箱/舱模型、六类约束校验、确定性规划器、事务式提交、交接明细
src/planner-store.js  数据层：localStorage 持久化与种子数据
src/planner-ui.js     界面层：渲染与交互（不含任何约束逻辑）
tests/                自动化测试（node:test，17 项）
scripts/browser-verify.mjs  真实浏览器验证（Playwright + Chromium，26 项）
```

## 使用

1. 打开 `planner.html`（或从 `index.html` 顶部链接进入）。
2. 在「箱体登记」维护转运箱（外廓/重量/可承重/重心高度/允许朝向/脆弱等级/禁邻类别/装卸港序）；在「舱位设置」调整堆叠上限、舱位承重与重心偏移阈值。
3. 箱体或舱位变更后自动重算：成功进入「预览待确认」，点「确认保存」生效；失败则列出冲突（箱号 + 约束），已提交的装载图、约束结果、交接明细保持不变。
4. 装载图上点箱 chip 再点目标舱位可手动移动；「交接明细」按靠港次序给出卸箱顺序。

## 测试与验证

```bash
npm test                # 数据层自动化测试（node:test）
npm run verify:browser  # 真实浏览器验证（需先 npm install 且本机有 Chromium）
```

验证结果见 `DELIVERY.md` 与 `verify-results.json`。
