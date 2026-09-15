/*
 * 出水文物转运装载规划台 —— 数据层（纯逻辑，无 DOM / 无存储依赖）
 *
 * 浏览器：window.PlannerCore；Node：module.exports。界面层不得在此出现。
 *
 * 术语与规则（与交付说明一致）：
 *  - 转运箱：外廓 dims{l,w,h}(cm)、重量 weight(kg)、可承重 maxLoad(kg，顶部允许堆载)、
 *    重心高度 cogHeight(cm，正放自箱底)、允许朝向 orientations、脆弱等级 fragility(1-5)、
 *    类别 category、禁邻类别 forbidNeighbors、装卸港序 portOrder（数值小=先靠港先卸）。
 *  - 货舱：隔层 decks、舱位 slots（deckId/row/col/maxStack/maxWeight）、
 *    重心偏移阈值 cogRatioLimit（叠放合成重心高度 / 叠放总高 的上限）。
 *  - 朝向有效尺寸：upright 正放 → 高=h、重心=cogHeight；side 侧放 → 高=w、重心=w/2。
 *  - 禁邻按“同层相邻”判定：同一隔层内行列相邻的两个舱位，同一高度层上两箱互为邻居。
 *  - 先卸后装：同一舱位叠放中，下层箱的 portOrder 必须 ≥ 上层箱（先卸的箱在上）。
 *  - 脆弱等级 ≥ FRAGILE_NO_STACK 的箱禁止任何上堆（无论其 maxLoad）。
 *
 * 确定性：全部排序使用显式比较器，不用 Date/Math.random；
 * 同一 (hold, boxes) 输入，generatePlan 输出逐字节一致。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlannerCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ORIENTATIONS = ["upright", "side"]; // 正放 / 侧放
  var ORIENTATION_NAMES = { upright: "正放", side: "侧放" };
  var FRAGILE_NO_STACK = 4; // 脆弱等级 ≥ 4：禁止上堆
  var DEFAULT_COG_RATIO_LIMIT = 0.55;

  var CONSTRAINT_NAMES = {
    "duplicate-box": "重复放置",
    "unknown-box": "未知箱号",
    "unknown-slot": "未知舱位",
    "level-gap": "层位悬空",
    "orientation": "固定方向",
    "stack-limit": "堆叠上限",
    "slot-weight": "舱位承重",
    "load-chain": "承重链",
    "fragility": "脆弱等级",
    "cog-offset": "重心偏移",
    "no-neighbor": "禁邻",
    "unload-order": "先卸后装",
    "unplaced": "无法安置"
  };

  /* ---------------- 基础工具 ---------------- */

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function round2(n) { return Math.round(n * 100) / 100; }

  /** 朝向对应的有效高度与有效重心高度（cm）。 */
  function effectiveDims(box, orientation) {
    if (orientation === "side") return { height: box.dims.w, cog: box.dims.w / 2 };
    return { height: box.dims.h, cog: box.cogHeight };
  }

  function boxByCode(boxes, code) {
    for (var i = 0; i < boxes.length; i++) if (boxes[i].code === code) return boxes[i];
    return null;
  }

  function slotById(hold, slotId) {
    for (var i = 0; i < hold.slots.length; i++) if (hold.slots[i].id === slotId) return hold.slots[i];
    return null;
  }

  /** 舱位确定性排序：隔层顺序 → 行 → 列 → id。 */
  function sortedSlots(hold) {
    var deckIndex = {};
    hold.decks.forEach(function (d, i) { deckIndex[d.id] = i; });
    return hold.slots.slice().sort(function (a, b) {
      return (deckIndex[a.deckId] - deckIndex[b.deckId]) ||
        (a.row - b.row) || (a.col - b.col) || cmpStr(a.id, b.id);
    });
  }

  /** 某舱位内的放置（按层升序，level 0 在最底）。 */
  function placementsInSlot(placements, slotId) {
    return placements.filter(function (p) { return p.slotId === slotId; })
      .sort(function (a, b) { return a.level - b.level; });
  }

  /* ---------------- 约束校验 ---------------- */

  /**
   * 校验完整或部分装载方案。
   * @returns {{ok:boolean, conflicts:Array<{boxCode:string,constraint:string,detail:string}>}}
   * conflicts 按（舱位序、层、箱号）确定性排序，保证同一输入输出一致。
   */
  function validatePlan(hold, boxes, placements, opts) {
    opts = opts || {};
    var conflicts = [];
    var cogLimit = hold.cogRatioLimit || DEFAULT_COG_RATIO_LIMIT;

    function push(boxCode, constraint, detail) {
      conflicts.push({ boxCode: boxCode, constraint: constraint, detail: detail });
    }

    // 结构校验：箱号/舱位存在、箱不重复、层位连续
    var seenBoxes = {};
    placements.forEach(function (p) {
      if (!boxByCode(boxes, p.boxCode)) push(p.boxCode, "unknown-box", "箱号未登记");
      if (!slotById(hold, p.slotId)) push(p.boxCode, "unknown-slot", "舱位 " + p.slotId + " 不存在");
      if (seenBoxes[p.boxCode]) push(p.boxCode, "duplicate-box", "同一箱被放置多次");
      seenBoxes[p.boxCode] = true;
    });

    sortedSlots(hold).forEach(function (slot) {
      var stack = placementsInSlot(placements, slot.id);
      if (!stack.length) return;

      // 层位必须从 0 连续
      stack.forEach(function (p, idx) {
        if (p.level !== idx) push(p.boxCode, "level-gap", "舱位 " + slot.id + " 第 " + p.level + " 层悬空");
      });

      // 堆叠上限
      if (stack.length > slot.maxStack) {
        stack.slice(slot.maxStack).forEach(function (p) {
          push(p.boxCode, "stack-limit", "舱位 " + slot.id + " 已叠 " + stack.length + " 箱，上限 " + slot.maxStack);
        });
      }

      // 舱位总承重
      var totalWeight = 0;
      stack.forEach(function (p) {
        var b = boxByCode(boxes, p.boxCode);
        if (b) totalWeight += b.weight;
      });
      if (totalWeight > slot.maxWeight) {
        push(stack[stack.length - 1].boxCode, "slot-weight",
          "舱位 " + slot.id + " 总重 " + round2(totalWeight) + "kg，超过舱位承重 " + slot.maxWeight + "kg");
      }

      // 逐箱：固定方向 / 承重链 / 脆弱等级 / 先卸后装；同时累计重心
      var heightBelow = 0, sumW = 0, sumWMoment = 0, totalHeight = 0;
      stack.forEach(function (p, idx) {
        var box = boxByCode(boxes, p.boxCode);
        if (!box) return;

        if (box.orientations.indexOf(p.orientation) === -1) {
          push(box.code, "orientation",
            "放置朝向「" + (ORIENTATION_NAMES[p.orientation] || p.orientation) + "」不在允许朝向内");
        }

        var aboveWeight = 0;
        for (var k = idx + 1; k < stack.length; k++) {
          var up = boxByCode(boxes, stack[k].boxCode);
          if (up) aboveWeight += up.weight;
        }
        if (aboveWeight > box.maxLoad) {
          push(box.code, "load-chain",
            "上方堆载 " + round2(aboveWeight) + "kg，超过可承重 " + box.maxLoad + "kg");
        }
        if (box.fragility >= FRAGILE_NO_STACK && aboveWeight > 0) {
          push(box.code, "fragility",
            "脆弱等级 " + box.fragility + "（≥" + FRAGILE_NO_STACK + "）禁止上方堆载，现有 " + round2(aboveWeight) + "kg");
        }

        if (idx + 1 < stack.length) {
          var upper = boxByCode(boxes, stack[idx + 1].boxCode);
          if (upper && box.portOrder < upper.portOrder) {
            push(box.code, "unload-order",
              "港序 " + box.portOrder + "（先卸）被港序 " + upper.portOrder + " 的 " + upper.code + " 压在下方");
          }
        }

        var eff = effectiveDims(box, p.orientation);
        sumW += box.weight;
        sumWMoment += box.weight * (heightBelow + eff.cog);
        heightBelow += eff.height;
        totalHeight = heightBelow;
      });

      // 重心偏移：合成重心高度 / 叠放总高 ≤ 阈值
      if (sumW > 0 && totalHeight > 0) {
        var cogH = sumWMoment / sumW;
        if (cogH > cogLimit * totalHeight + 1e-9) {
          push(stack[stack.length - 1].boxCode, "cog-offset",
            "舱位 " + slot.id + " 合成重心高 " + round2(cogH) + "cm，超过限值 " +
            round2(cogLimit * totalHeight) + "cm（阈值 " + cogLimit + " × 总高 " + round2(totalHeight) + "cm）");
        }
      }
    });

    // 禁邻：同层相邻（同一隔层、行列相邻、同一高度层）
    sortedSlots(hold).forEach(function (slot) {
      var neighbors = [
        slotById(hold, neighborId(slot, 1, 0)),
        slotById(hold, neighborId(slot, 0, 1))
      ];
      var stackA = placementsInSlot(placements, slot.id);
      neighbors.forEach(function (nb) {
        if (!nb) return;
        var stackB = placementsInSlot(placements, nb.id);
        stackA.forEach(function (pa) {
          var boxA = boxByCode(boxes, pa.boxCode);
          if (!boxA) return;
          stackB.forEach(function (pb) {
            if (pb.level !== pa.level) return;
            var boxB = boxByCode(boxes, pb.boxCode);
            if (!boxB) return;
            if (boxA.forbidNeighbors.indexOf(boxB.category) !== -1) {
              push(boxA.code, "no-neighbor",
                "与相邻舱位 " + nb.id + " 同层的 " + boxB.code + "（" + boxB.category + "）属于禁邻类别");
            }
            if (boxB.forbidNeighbors.indexOf(boxA.category) !== -1) {
              push(boxB.code, "no-neighbor",
                "与相邻舱位 " + slot.id + " 同层的 " + boxA.code + "（" + boxA.category + "）属于禁邻类别");
            }
          });
        });
      });
    });

    // 完整性：每个登记的箱都必须被放置（部分校验时跳过，供规划器增量使用）
    if (!opts.partial) {
      boxes.forEach(function (b) {
        if (!seenBoxes[b.code]) push(b.code, "unplaced", "箱未安置到任何舱位");
      });
    }

    conflicts.sort(function (a, b) {
      return cmpStr(a.boxCode, b.boxCode) || cmpStr(a.constraint, b.constraint) || cmpStr(a.detail, b.detail);
    });
    return { ok: conflicts.length === 0, conflicts: conflicts };
  }

  function neighborId(slot, dRow, dCol) {
    // 舱位 id 约定：deckId-R行C列；按行列推导相邻 id，找不到时返回 null
    return slot.deckId + "-R" + (slot.row + dRow) + "C" + (slot.col + dCol);
  }

  /* ---------------- 确定性规划器 ---------------- */

  /**
   * 自动生成装载方案。同一 (hold, boxes) 必得同一结果。
   * 装箱顺序：港序大（后卸）→ 重量大 → 箱号字典序；
   * 舱位顺序：隔层 → 行 → 列；每层先试允许朝向（字典序）。
   * @returns {{ok:boolean, placements:?Array, conflicts:Array}}
   */
  function generatePlan(hold, boxes) {
    var order = boxes.slice().sort(function (a, b) {
      return (b.portOrder - a.portOrder) || (b.weight - a.weight) || cmpStr(a.code, b.code);
    });
    var slots = sortedSlots(hold);
    var placements = [];

    for (var i = 0; i < order.length; i++) {
      var box = order[i];
      var placed = false;
      for (var s = 0; s < slots.length && !placed; s++) {
        var slot = slots[s];
        var level = placementsInSlot(placements, slot.id).length;
        var oris = box.orientations.slice().sort();
        for (var o = 0; o < oris.length; o++) {
          var candidate = placements.concat([{
            boxCode: box.code, slotId: slot.id, level: level, orientation: oris[o]
          }]);
          if (validatePlan(hold, boxes, candidate, { partial: true }).ok) {
            placements = candidate;
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        return {
          ok: false,
          placements: null,
          conflicts: [{ boxCode: box.code, constraint: "unplaced", detail: "所有舱位均无法满足约束，箱无法安置" }]
        };
      }
    }
    return { ok: true, placements: placements, conflicts: [] };
  }

  /* ---------------- 事务式提交 ---------------- */

  /**
   * 用候选方案提交新状态。校验失败：返回 ok:false 且原 state 原样返回（不改引用）；
   * 成功：返回携带新 装载图/约束结果/交接明细 的新 state（原 state 不被修改）。
   */
  function commitPlan(state, placements) {
    var report = validatePlan(state.hold, state.boxes, placements);
    if (!report.ok) return { ok: false, conflicts: report.conflicts, state: state };
    var newState = {
      hold: state.hold,
      boxes: state.boxes,
      plan: { placements: clone(placements) },
      report: report,
      handover: buildHandover(state.hold, state.boxes, placements)
    };
    return { ok: true, conflicts: [], state: newState };
  }

  /* ---------------- 交接明细 ---------------- */

  /** 按靠港次序（先卸在前）生成交接明细。 */
  function buildHandover(hold, boxes, placements) {
    var slots = {};
    hold.slots.forEach(function (s) { slots[s.id] = s; });
    var lines = placements.map(function (p) {
      var box = boxByCode(boxes, p.boxCode);
      var slot = slots[p.slotId];
      return {
        boxCode: p.boxCode,
        portOrder: box ? box.portOrder : 0,
        deckId: slot ? slot.deckId : "?",
        slotId: p.slotId,
        level: p.level,
        orientation: p.orientation,
        weight: box ? box.weight : 0
      };
    });
    lines.sort(function (a, b) {
      return (a.portOrder - b.portOrder) || cmpStr(a.deckId, b.deckId) ||
        cmpStr(a.slotId, b.slotId) || (b.level - a.level) || cmpStr(a.boxCode, b.boxCode);
    });
    var ports = [];
    lines.forEach(function (l) {
      var g = null;
      for (var i = 0; i < ports.length; i++) if (ports[i].portOrder === l.portOrder) { g = ports[i]; break; }
      if (!g) { g = { portOrder: l.portOrder, boxes: [], totalWeight: 0 }; ports.push(g); }
      g.boxes.push(l);
      g.totalWeight = round2(g.totalWeight + l.weight);
    });
    return { generatedFrom: "committed-plan", ports: ports, totalBoxes: lines.length };
  }

  /* ---------------- 数据规范化 ---------------- */

  /** 校验并规范化箱登记数据；返回错误数组（空 = 合法）。 */
  function validateBox(box) {
    var errors = [];
    if (!box.code || !/^[A-Za-z0-9-]+$/.test(box.code)) errors.push("箱号必填，仅限字母数字与连字符");
    ["l", "w", "h"].forEach(function (k) {
      if (!(box.dims && box.dims[k] > 0)) errors.push("外廓 " + k + " 必须为正数");
    });
    if (!(box.weight > 0)) errors.push("重量必须为正数");
    if (!(box.maxLoad >= 0)) errors.push("可承重不能为负");
    if (!(box.cogHeight >= 0 && box.cogHeight <= box.dims.h)) errors.push("重心高度须在 0 与外廓高之间");
    if (!Array.isArray(box.orientations) || !box.orientations.length ||
        box.orientations.some(function (o) { return ORIENTATIONS.indexOf(o) === -1; })) {
      errors.push("允许朝向至少一项，且只能是 upright/side");
    }
    if (!(box.fragility >= 1 && box.fragility <= 5)) errors.push("脆弱等级须为 1-5");
    if (!box.category) errors.push("类别必填（用于禁邻判定）");
    if (!Array.isArray(box.forbidNeighbors)) errors.push("禁邻类别须为数组");
    if (!(Number.isInteger(box.portOrder) && box.portOrder >= 1)) errors.push("装卸港序须为 ≥1 的整数");
    return errors;
  }

  return {
    ORIENTATIONS: ORIENTATIONS,
    ORIENTATION_NAMES: ORIENTATION_NAMES,
    CONSTRAINT_NAMES: CONSTRAINT_NAMES,
    FRAGILE_NO_STACK: FRAGILE_NO_STACK,
    DEFAULT_COG_RATIO_LIMIT: DEFAULT_COG_RATIO_LIMIT,
    clone: clone,
    effectiveDims: effectiveDims,
    sortedSlots: sortedSlots,
    placementsInSlot: placementsInSlot,
    validatePlan: validatePlan,
    generatePlan: generatePlan,
    commitPlan: commitPlan,
    buildHandover: buildHandover,
    validateBox: validateBox
  };
});
