"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/planner-core.js");
const Store = require("../src/planner-store.js");

/* ---------- 测试夹具 ---------- */

function makeHold() {
  return {
    cogRatioLimit: 0.5,
    decks: [{ id: "D1", name: "上隔层" }],
    slots: [
      { id: "D1-R1C1", deckId: "D1", row: 1, col: 1, maxStack: 3, maxWeight: 1000 },
      { id: "D1-R1C2", deckId: "D1", row: 1, col: 2, maxStack: 3, maxWeight: 1000 },
      { id: "D1-R2C1", deckId: "D1", row: 2, col: 1, maxStack: 2, maxWeight: 500 }
    ]
  };
}

function box(over) {
  return Object.assign({
    code: "BX-1", dims: { l: 100, w: 80, h: 100 }, weight: 100, maxLoad: 150,
    cogHeight: 50, orientations: ["upright"], fragility: 1,
    category: "陶瓷", forbidNeighbors: [], portOrder: 1
  }, over);
}

function constraintsOf(report) {
  return report.conflicts.map(c => c.constraint);
}

/* ---------- 六类约束各自检出，且指明箱号 ---------- */

test("承重链：上方堆载超过可承重，报箱号", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-A", maxLoad: 50 }), box({ code: "BX-B", weight: 100, portOrder: 1 })];
  const placements = [
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const r = Core.validatePlan(hold, boxes, placements);
  assert.equal(r.ok, false);
  const c = r.conflicts.find(c => c.constraint === "load-chain");
  assert.ok(c, "应检出承重链冲突");
  assert.equal(c.boxCode, "BX-A");
  assert.match(c.detail, /可承重/);
});

test("堆叠上限：舱位箱数超限", () => {
  const hold = makeHold();
  hold.slots[0].maxStack = 1;
  const boxes = [box({ code: "BX-A" }), box({ code: "BX-B" })];
  const placements = [
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const r = Core.validatePlan(hold, boxes, placements);
  assert.ok(constraintsOf(r).includes("stack-limit"));
  assert.equal(r.conflicts.find(c => c.constraint === "stack-limit").boxCode, "BX-B");
});

test("重心偏移：合成重心超高", () => {
  const hold = makeHold(); // 阈值 0.5
  const boxes = [
    box({ code: "BX-A", cogHeight: 90, weight: 100 }),
    box({ code: "BX-B", cogHeight: 90, weight: 100 })
  ];
  const placements = [
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  // 合成重心 = (100*90 + 100*190)/200 = 140cm > 0.5*200
  const r = Core.validatePlan(hold, boxes, placements);
  assert.ok(constraintsOf(r).includes("cog-offset"));
});

test("固定方向：放置朝向不在允许朝向内", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-A", orientations: ["upright"] })];
  const placements = [{ boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "side" }];
  const r = Core.validatePlan(hold, boxes, placements);
  const c = r.conflicts.find(c => c.constraint === "orientation");
  assert.ok(c);
  assert.equal(c.boxCode, "BX-A");
});

test("禁邻：同层相邻舱位的禁邻类别", () => {
  const hold = makeHold();
  const boxes = [
    box({ code: "BX-A", category: "陶瓷", forbidNeighbors: ["金属"] }),
    box({ code: "BX-B", category: "金属" })
  ];
  const placements = [
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R1C2", level: 0, orientation: "upright" }
  ];
  const r = Core.validatePlan(hold, boxes, placements);
  const c = r.conflicts.find(c => c.constraint === "no-neighbor");
  assert.ok(c, "应检出禁邻冲突");
  assert.equal(c.boxCode, "BX-A");
  // 对角舱位（R1C2 与 R2C1）不构成相邻，不应报禁邻
  const ok = Core.validatePlan(hold, boxes, [
    { boxCode: "BX-A", slotId: "D1-R1C2", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R2C1", level: 0, orientation: "upright" }
  ]);
  assert.ok(!ok.conflicts.some(c => c.constraint === "no-neighbor"), "不相邻舱位不应报禁邻");
});

test("先卸后装：先卸箱被后卸箱压在下方，报先卸箱号", () => {
  const hold = makeHold();
  const boxes = [
    box({ code: "BX-EARLY", portOrder: 1 }),
    box({ code: "BX-LATE", portOrder: 2 })
  ];
  const placements = [
    { boxCode: "BX-EARLY", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-LATE", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const r = Core.validatePlan(hold, boxes, placements);
  const c = r.conflicts.find(c => c.constraint === "unload-order");
  assert.ok(c);
  assert.equal(c.boxCode, "BX-EARLY");
  assert.match(c.detail, /BX-LATE/);
});

test("先卸后装：正确叠放（先卸在上）通过", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-EARLY", portOrder: 1 }), box({ code: "BX-LATE", portOrder: 2 })];
  const placements = [
    { boxCode: "BX-LATE", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-EARLY", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  assert.equal(Core.validatePlan(hold, boxes, placements).ok, true);
});

test("脆弱等级：≥4 禁止上堆", () => {
  const hold = makeHold();
  const boxes = [
    box({ code: "BX-FRAG", fragility: 4, maxLoad: 999 }),
    box({ code: "BX-TOP", weight: 10 })
  ];
  const placements = [
    { boxCode: "BX-FRAG", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-TOP", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const r = Core.validatePlan(hold, boxes, placements);
  const c = r.conflicts.find(c => c.constraint === "fragility");
  assert.ok(c);
  assert.equal(c.boxCode, "BX-FRAG");
});

/* ---------- 规划器 ---------- */

test("确定性：同一输入重复生成，方案逐字节一致", () => {
  const state = Store.seedState();
  const a = Core.generatePlan(state.hold, state.boxes);
  const b = Core.generatePlan(state.hold, state.boxes);
  assert.equal(a.ok, true);
  assert.deepEqual(a.placements, b.placements);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("确定性：输入箱顺序打乱，方案仍一致", () => {
  const state = Store.seedState();
  const shuffled = state.boxes.slice().reverse();
  const a = Core.generatePlan(state.hold, state.boxes);
  const b = Core.generatePlan(state.hold, shuffled);
  assert.deepEqual(a.placements, b.placements);
});

test("生成的方案自身通过全部约束校验", () => {
  const state = Store.seedState();
  const gen = Core.generatePlan(state.hold, state.boxes);
  assert.equal(gen.ok, true);
  const r = Core.validatePlan(state.hold, state.boxes, gen.placements);
  assert.equal(r.ok, true, JSON.stringify(r.conflicts, null, 2));
});

test("容量不足：生成失败并报真实约束（堆叠上限）与箱号", () => {
  const hold = makeHold();
  hold.slots = [hold.slots[0]];
  hold.slots[0].maxStack = 1;
  const boxes = [box({ code: "BX-A" }), box({ code: "BX-B" })];
  const gen = Core.generatePlan(hold, boxes);
  assert.equal(gen.ok, false);
  assert.equal(gen.placements, null);
  assert.equal(gen.conflicts[0].constraint, "stack-limit");
  assert.equal(gen.conflicts[0].boxCode, "BX-B");
  assert.ok(!gen.conflicts.some(c => c.constraint === "unplaced"), "有真实约束时不应只报无法安置");
});

/* ---------- 事务式提交：失败时原数据不变 ---------- */

test("提交失败：原装载图、约束结果、交接明细均不变", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-A" }), box({ code: "BX-B", portOrder: 2 })];
  const good = [
    { boxCode: "BX-B", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const first = Core.commitPlan({ hold, boxes }, good);
  assert.equal(first.ok, true);
  const committed = first.state;
  const snapshot = Core.clone(committed);

  const bad = [ // 先卸后装冲突
    { boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" },
    { boxCode: "BX-B", slotId: "D1-R1C1", level: 1, orientation: "upright" }
  ];
  const res = Core.commitPlan(committed, bad);
  assert.equal(res.ok, false);
  assert.ok(res.conflicts.length > 0);
  assert.strictEqual(res.state, committed, "失败时必须返回原状态引用");
  assert.deepEqual(committed, snapshot, "原状态不得被修改");
  assert.deepEqual(committed.plan.placements, good);
});

test("提交成功：返回新状态，原状态不被修改", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-A" })];
  const base = { hold, boxes, plan: null, report: null, handover: null };
  const placements = [{ boxCode: "BX-A", slotId: "D1-R1C1", level: 0, orientation: "upright" }];
  const res = Core.commitPlan(base, placements);
  assert.equal(res.ok, true);
  assert.notStrictEqual(res.state, base);
  assert.equal(base.plan, null, "原状态不得被修改");
  assert.equal(res.state.plan.placements.length, 1);
  assert.equal(res.state.report.ok, true);
  assert.equal(res.state.handover.totalBoxes, 1);
});

/* ---------- 交接明细 ---------- */

test("交接明细：按港序升序分组，先卸在前，重量合计正确", () => {
  const state = Store.seedState();
  const gen = Core.generatePlan(state.hold, state.boxes);
  const committed = Core.commitPlan(state, gen.placements).state;
  const ports = committed.handover.ports;
  assert.ok(ports.length >= 2);
  for (let i = 1; i < ports.length; i++) assert.ok(ports[i].portOrder >= ports[i - 1].portOrder);
  const total = ports.reduce((s, p) => s + p.boxes.length, 0);
  assert.equal(total, state.boxes.length);
  ports.forEach(p => {
    const sum = p.boxes.reduce((s, b) => s + b.weight, 0);
    assert.ok(Math.abs(sum - p.totalWeight) < 0.01);
  });
});

/* ---------- 持久化 ---------- */

test("存储：内存适配器保存/读取往返一致", () => {
  const mem = {};
  const adapter = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); }
  };
  const store = Store.createStore(adapter);
  const loaded = store.load(); // 首次写种子
  assert.ok(loaded.plan && loaded.plan.placements.length === loaded.boxes.length);
  loaded.boxes[0].weight = 12345;
  store.save(loaded);
  const again = store.load();
  assert.equal(again.boxes[0].weight, 12345);
  assert.deepEqual(again, loaded);
});

/* ---------- 登记数据校验 ---------- */

test("validateBox：非法数据逐项报错", () => {
  const errors = Core.validateBox({
    code: "", dims: { l: 0, w: 1, h: 1 }, weight: -1, maxLoad: -1, cogHeight: 99,
    orientations: [], fragility: 9, category: "", forbidNeighbors: null, portOrder: 0
  });
  assert.ok(errors.length >= 8);
  assert.equal(Core.validateBox(box({ code: "BX-OK" })).length, 0);
});
