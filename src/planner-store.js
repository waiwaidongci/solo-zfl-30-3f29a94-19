/*
 * 持久化层：localStorage 读写 + 种子数据。仅依赖 PlannerCore，不碰 DOM。
 * 浏览器：window.PlannerStore；Node：module.exports（注入 storage 适配器便于测试）。
 */
(function (root, factory) {
  var core = (typeof module === "object" && module.exports)
    ? require("./planner-core.js")
    : root.PlannerCore;
  var api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlannerStore = api;
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  var STORAGE_KEY = "relicTransferPlanner.v1";

  /** 种子数据：2 个隔层 × 6 舱位，6 个转运箱。 */
  function seedState() {
    var hold = {
      cogRatioLimit: 0.55,
      decks: [
        { id: "D1", name: "上隔层" },
        { id: "D2", name: "下隔层" }
      ],
      slots: []
    };
    ["D1", "D2"].forEach(function (deckId) {
      for (var r = 1; r <= 2; r++) {
        for (var c = 1; c <= 3; c++) {
          hold.slots.push({
            id: deckId + "-R" + r + "C" + c,
            deckId: deckId, row: r, col: c,
            maxStack: 3, maxWeight: 900
          });
        }
      }
    });
    var boxes = [
      { code: "BX-101", dims: { l: 120, w: 80, h: 90 }, weight: 260, maxLoad: 300, cogHeight: 40,
        orientations: ["upright"], fragility: 2, category: "陶瓷", forbidNeighbors: ["金属"], portOrder: 2 },
      { code: "BX-102", dims: { l: 100, w: 70, h: 80 }, weight: 180, maxLoad: 200, cogHeight: 36,
        orientations: ["upright", "side"], fragility: 3, category: "陶瓷", forbidNeighbors: [], portOrder: 2 },
      { code: "BX-103", dims: { l: 140, w: 90, h: 100 }, weight: 320, maxLoad: 400, cogHeight: 45,
        orientations: ["upright"], fragility: 1, category: "金属", forbidNeighbors: ["陶瓷"], portOrder: 3 },
      { code: "BX-104", dims: { l: 90, w: 60, h: 70 }, weight: 120, maxLoad: 0, cogHeight: 30,
        orientations: ["upright"], fragility: 4, category: "有机质", forbidNeighbors: ["金属"], portOrder: 1 },
      { code: "BX-105", dims: { l: 110, w: 75, h: 85 }, weight: 210, maxLoad: 250, cogHeight: 38,
        orientations: ["upright", "side"], fragility: 2, category: "陶瓷", forbidNeighbors: [], portOrder: 1 },
      { code: "BX-106", dims: { l: 130, w: 85, h: 95 }, weight: 290, maxLoad: 350, cogHeight: 42,
        orientations: ["upright"], fragility: 2, category: "金属", forbidNeighbors: [], portOrder: 3 }
    ];
    var gen = Core.generatePlan(hold, boxes);
    var base = { hold: hold, boxes: boxes, plan: null, report: null, handover: null };
    var committed = Core.commitPlan(base, gen.placements || []);
    return committed.ok ? committed.state : base;
  }

  /** 创建存储。adapter 缺省用 localStorage；测试可注入内存对象。 */
  function createStore(adapter) {
    var storage = adapter || (typeof localStorage !== "undefined" ? localStorage : null);
    var memory = {};
    function read() {
      try {
        var raw = storage ? storage.getItem(STORAGE_KEY) : memory[STORAGE_KEY];
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
    function write(state) {
      var raw = JSON.stringify(state);
      if (storage) storage.setItem(STORAGE_KEY, raw);
      else memory[STORAGE_KEY] = raw;
    }
    return {
      /** 载入已提交状态；无数据时写入种子并返回。 */
      load: function () {
        var state = read();
        if (state && state.hold && state.boxes) return state;
        state = seedState();
        write(state);
        return state;
      },
      save: write,
      reset: function () { var s = seedState(); write(s); return s; }
    };
  }

  return { STORAGE_KEY: STORAGE_KEY, seedState: seedState, createStore: createStore };
});
