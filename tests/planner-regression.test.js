"use strict";
/*
 * 回归测试：重算失败后的状态一致性 与 失败诊断的真实约束。
 * 对应缺陷：箱重超限后页面混用草稿值；冲突只报笼统“无法安置”。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/planner-core.js");
const Store = require("../src/planner-store.js");

function makeHold() {
  return {
    cogRatioLimit: 0.5,
    decks: [{ id: "D1", name: "上隔层" }],
    slots: [
      { id: "D1-R1C1", deckId: "D1", row: 1, col: 1, maxStack: 3, maxWeight: 1000 },
      { id: "D1-R1C2", deckId: "D1", row: 1, col: 2, maxStack: 3, maxWeight: 1000 }
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

test("回归：箱重超过所有舱位承重时，报真实约束 slot-weight 而非笼统无法安置", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-HEAVY", weight: 5000 })];
  const gen = Core.generatePlan(hold, boxes);
  assert.equal(gen.ok, false);
  assert.equal(gen.placements, null);
  const c = gen.conflicts.find(c => c.boxCode === "BX-HEAVY");
  assert.ok(c, "必须指明失败箱号");
  assert.equal(c.constraint, "slot-weight");
  assert.match(c.detail, /5000/);
  assert.match(c.detail, /1000/);
  assert.ok(!gen.conflicts.some(c => c.constraint === "unplaced"), "存在真实约束时不得只报无法安置");
});

test("回归：失败诊断确定性——同一输入重复生成，冲突列表一致", () => {
  const hold = makeHold();
  const boxes = [box({ code: "BX-HEAVY", weight: 5000 }), box({ code: "BX-OK", weight: 50 })];
  const a = Core.generatePlan(hold, boxes);
  const b = Core.generatePlan(hold, boxes.slice().reverse());
  assert.equal(a.ok, false);
  assert.deepEqual(a.conflicts, b.conflicts);
});

test("回归：失败诊断可含多种真实约束（承重链 + 舱位承重）", () => {
  const hold = makeHold();
  hold.slots = [hold.slots[0]]; // 只剩一个舱位
  const boxes = [
    box({ code: "BX-BASE", weight: 800, maxLoad: 10 }), // 占住唯一舱位底层
    box({ code: "BX-TOP", weight: 500 })                // 放上后同时压爆承重链与舱位承重
  ];
  const gen = Core.generatePlan(hold, boxes);
  assert.equal(gen.ok, false);
  const kinds = gen.conflicts.map(c => c.constraint);
  assert.ok(kinds.includes("load-chain"), "应含承重链冲突");
  assert.ok(kinds.includes("slot-weight"), "应含舱位承重冲突");
  assert.ok(gen.conflicts.every(c => c.boxCode), "每条冲突都必须有箱号");
});

test("回归：提交失败后，已提交的装载图/约束结果/交接明细与失败前逐字节一致", () => {
  const state = Store.seedState();
  const before = JSON.stringify({
    plan: state.plan, report: state.report, handover: state.handover
  });
  // 模拟“箱重调到超限后重算失败再尝试提交”：用超限箱构造非法方案
  const badBoxes = state.boxes.map(b => b.code === "BX-101" ? Object.assign({}, b, { weight: 99999 }) : b);
  const draftState = { hold: state.hold, boxes: badBoxes };
  const res = Core.commitPlan(draftState, state.plan.placements);
  assert.equal(res.ok, false);
  assert.ok(res.conflicts.length > 0);
  const after = JSON.stringify({
    plan: state.plan, report: state.report, handover: state.handover
  });
  assert.equal(after, before, "失败不得改动已提交的装载图、约束结果、交接明细");
});

test("回归：已提交方案的约束结果本身始终通过校验", () => {
  const state = Store.seedState();
  const r = Core.validatePlan(state.hold, state.boxes, state.plan.placements);
  assert.equal(r.ok, true);
  assert.equal(state.report.ok, true);
});
