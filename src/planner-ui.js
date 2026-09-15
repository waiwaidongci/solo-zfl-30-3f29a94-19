/*
 * 界面层：仅负责渲染与交互。所有约束判定、方案生成、提交事务都在 PlannerCore，
 * 持久化在 PlannerStore。本层不实现任何约束逻辑。
 */
(function () {
  "use strict";
  var Core = window.PlannerCore;
  var store = window.PlannerStore.createStore();

  var committed = store.load();          // 已提交：装载图/约束结果/交接明细的唯一真实来源
  var draft = Core.clone(committed);     // 草稿：箱体/舱位变更都先落在草稿
  var preview = null;                    // 重算成功的候选方案（未确认）
  var conflicts = [];                    // 最近一次失败的冲突列表
  var selectedBox = null;                // 装载图上选中的箱号（用于移动）

  var $ = function (sel) { return document.querySelector(sel); };
  var diagramEl = $("#diagram"), conflictPanel = $("#conflictPanel"),
      handoverEl = $("#handoverList"), boxListEl = $("#boxList"),
      statusBadge = $("#statusBadge"), diagramMode = $("#diagramMode"),
      boxForm = $("#boxForm"), slotSelect = $("#slotSelect");

  var PALETTE = ["#b56c38", "#6e7880", "#6c4b2f", "#725ca6", "#1d6c78", "#8a6d1f", "#4a7a4f"];
  function catColor(category) {
    var hash = 0;
    for (var i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- 重算与提交（事务语义来自 Core） ---------- */

  function recompute() {
    var gen = Core.generatePlan(draft.hold, draft.boxes);
    if (gen.ok) { preview = { placements: gen.placements }; conflicts = []; }
    else { preview = null; conflicts = gen.conflicts; } // 失败：已提交的装载图/约束结果/交接明细不动
    selectedBox = null;
    render();
  }

  function commit() {
    if (!preview) return;
    var res = Core.commitPlan({ hold: draft.hold, boxes: draft.boxes }, preview.placements);
    if (res.ok) {
      committed = res.state;
      store.save(committed);
      draft = Core.clone(committed);
      preview = null; conflicts = [];
    } else {
      conflicts = res.conflicts; // 拒绝保存：committed 原样保留
    }
    render();
  }

  /* ---------- 渲染 ---------- */

  function activePlacements() {
    return preview ? preview.placements : (committed.plan ? committed.plan.placements : []);
  }

  /**
   * 装载图的单一数据源：有预览时用草稿（箱/舱/候选方案三者一致），
   * 否则整体回退到已提交状态——重算失败时绝不允许 committed 的摆放
   * 配上 draft 的重量/舱位现重等草稿值混着显示。
   */
  function viewModel() {
    if (preview) {
      return { placements: preview.placements, hold: draft.hold, boxes: draft.boxes };
    }
    return {
      placements: committed.plan ? committed.plan.placements : [],
      hold: committed.hold,
      boxes: committed.boxes
    };
  }

  function boxIn(boxes, code) {
    for (var i = 0; i < boxes.length; i++) if (boxes[i].code === code) return boxes[i];
    return null;
  }

  function render() {
    renderStatus();
    renderDiagram();
    renderConflicts();
    renderHandover();
    renderBoxList();
    renderSlotEditor();
  }

  function renderStatus() {
    if (conflicts.length) {
      statusBadge.className = "badge error";
      statusBadge.textContent = "冲突 " + conflicts.length + " 项 · 未保存";
    } else if (preview) {
      statusBadge.className = "badge preview";
      statusBadge.textContent = "预览待确认";
    } else {
      statusBadge.className = "badge clean";
      statusBadge.textContent = "已提交";
    }
    diagramMode.textContent = preview ? "（预览 · 确认保存后生效）" : "（已提交方案）";
    $("#btnCommit").disabled = !(preview && !conflicts.length);
  }

  function renderDiagram() {
    var view = viewModel();
    var placements = view.placements;
    var conflictBoxes = {};
    conflicts.forEach(function (c) { conflictBoxes[c.boxCode] = true; });
    var slotHasConflict = {};
    placements.forEach(function (p) { if (conflictBoxes[p.boxCode]) slotHasConflict[p.slotId] = true; });

    diagramEl.innerHTML = "";
    view.hold.decks.forEach(function (deck) {
      var deckEl = document.createElement("div");
      deckEl.className = "deck";
      var slots = Core.sortedSlots(view.hold).filter(function (s) { return s.deckId === deck.id; });
      var maxCol = slots.reduce(function (m, s) { return Math.max(m, s.col); }, 1);
      deckEl.innerHTML = "<h3>" + esc(deck.name) + "（" + esc(deck.id) + "）</h3>";
      var grid = document.createElement("div");
      grid.className = "slots";
      grid.style.gridTemplateColumns = "repeat(" + maxCol + ", 1fr)";
      slots.forEach(function (slot) { grid.appendChild(renderSlot(slot, view, conflictBoxes, slotHasConflict)); });
      deckEl.appendChild(grid);
      diagramEl.appendChild(deckEl);
    });
  }

  function renderSlot(slot, view, conflictBoxes, slotHasConflict) {
    var el = document.createElement("div");
    el.className = "slot" + (slotHasConflict[slot.id] ? " conflict" : "");
    el.dataset.slotId = slot.id;
    var stack = Core.placementsInSlot(view.placements, slot.id);
    var totalW = stack.reduce(function (sum, p) {
      var b = boxIn(view.boxes, p.boxCode); return sum + (b ? b.weight : 0);
    }, 0);
    el.innerHTML = '<div class="slot-head"><span>' + esc(slot.id) + '</span><span>≤' + slot.maxStack +
      '箱 · ≤' + slot.maxWeight + 'kg · 现 ' + Math.round(totalW) + 'kg</span></div>';
    var stackEl = document.createElement("div");
    stackEl.className = "stack";
    stack.forEach(function (p) {
      var box = boxIn(view.boxes, p.boxCode);
      if (!box) return;
      var chip = document.createElement("div");
      chip.className = "chip" + (conflictBoxes[p.boxCode] ? " conflict" : "") +
        (selectedBox === p.boxCode ? " selected" : "");
      chip.style.background = catColor(box.category);
      chip.dataset.boxCode = p.boxCode;
      chip.innerHTML = esc(p.boxCode) + "<small>" +
        esc(Core.ORIENTATION_NAMES[p.orientation] || p.orientation) + " · " + box.weight + "kg · 港序" + box.portOrder + "</small>";
      chip.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectedBox = (selectedBox === p.boxCode) ? null : p.boxCode;
        render();
      });
      stackEl.appendChild(chip);
    });
    el.appendChild(stackEl);
    el.addEventListener("click", function () { onSlotClick(slot.id); });
    return el;
  }

  function renderConflicts() {
    // 已提交方案的约束结果始终展示；重算失败时在其下方追加真实失败约束
    var committedLine = committed.plan
      ? '<div class="ok-line" id="committedReport">已提交方案约束结果：满足承重链、堆叠上限、重心偏移、固定方向、禁邻、先卸后装全部约束。</div>'
      : '<div class="muted" id="committedReport">暂无已提交方案。</div>';
    if (conflicts.length) {
      conflictPanel.innerHTML = committedLine +
        "<h3>本次重算失败（已拒绝保存，上方已提交方案不受影响）</h3><div class='conflict-list'>" +
        conflicts.map(function (c) {
          return '<div class="conflict-item"><b>' + esc(c.boxCode) + " · " +
            esc(Core.CONSTRAINT_NAMES[c.constraint] || c.constraint) + "</b><br>" + esc(c.detail) + "</div>";
        }).join("") + "</div>";
    } else if (preview) {
      conflictPanel.innerHTML = committedLine +
        '<div class="ok-line">本次重算校验通过：满足全部约束。请「确认保存」。</div>';
    } else {
      conflictPanel.innerHTML = committedLine;
    }
  }

  function renderHandover() {
    var handover = committed.handover;
    if (!handover || !handover.ports.length) {
      handoverEl.innerHTML = '<div class="muted">暂无已提交方案。</div>';
      return;
    }
    handoverEl.innerHTML = handover.ports.map(function (port) {
      var rows = port.boxes.map(function (b) {
        return "<tr><td>" + esc(b.boxCode) + "</td><td>" + esc(b.slotId) + "</td><td>第" + (b.level + 1) +
          "层</td><td>" + esc(Core.ORIENTATION_NAMES[b.orientation] || b.orientation) + "</td><td>" + b.weight + "kg</td></tr>";
      }).join("");
      return '<div class="handover-port"><b>港序 ' + port.portOrder + '</b> <span class="muted">先卸 · 共 ' +
        port.boxes.length + " 箱 / " + port.totalWeight + 'kg</span><table><tr><th>箱号</th><th>舱位</th><th>层</th><th>朝向</th><th>重量</th></tr>' +
        rows + "</table></div>";
    }).join("");
  }

  function renderBoxList() {
    boxListEl.innerHTML = draft.boxes.map(function (b) {
      return '<div class="box-item' + (boxForm.originalCode.value === b.code ? " active" : "") +
        '" data-code="' + esc(b.code) + '"><b>' + esc(b.code) + "</b> · " + esc(b.category) +
        ' <span class="muted">' + b.weight + "kg · 承重" + b.maxLoad + "kg · 脆弱" + b.fragility +
        " · 港序" + b.portOrder + "</span></div>";
    }).join("");
    boxListEl.querySelectorAll("[data-code]").forEach(function (el) {
      el.addEventListener("click", function () { fillBoxForm(el.dataset.code); });
    });
  }

  function renderSlotEditor() {
    var current = slotSelect.value;
    slotSelect.innerHTML = Core.sortedSlots(draft.hold).map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.id) + "（" + esc(s.deckId) + "）</option>";
    }).join("");
    if (current) slotSelect.value = current;
    syncSlotInputs();
    $("#cogLimit").value = draft.hold.cogRatioLimit;
  }

  function syncSlotInputs() {
    var slot = Core.sortedSlots(draft.hold).filter(function (s) { return s.id === slotSelect.value; })[0];
    if (!slot) return;
    $("#slotMaxStack").value = slot.maxStack;
    $("#slotMaxWeight").value = slot.maxWeight;
  }

  /* ---------- 交互 ---------- */

  function findBox(code) {
    return draft.boxes.filter(function (b) { return b.code === code; })[0] || null;
  }

  /** 层号归一：每个舱位内按层排序后重排为 0..n-1，保证无悬空。 */
  function normalizeLevels(placements) {
    var bySlot = {};
    placements.forEach(function (p) { (bySlot[p.slotId] = bySlot[p.slotId] || []).push(p); });
    var out = [];
    Object.keys(bySlot).forEach(function (slotId) {
      bySlot[slotId].sort(function (a, b) { return a.level - b.level; })
        .forEach(function (p, i) { out.push({ boxCode: p.boxCode, slotId: p.slotId, level: i, orientation: p.orientation }); });
    });
    return out;
  }

  function onSlotClick(slotId) {
    if (!selectedBox) return;
    var box = findBox(selectedBox);
    if (!box) { selectedBox = null; render(); return; }
    var base = normalizeLevels(activePlacements().filter(function (p) { return p.boxCode !== selectedBox; }));
    var current = activePlacements().filter(function (p) { return p.boxCode === selectedBox; })[0];
    var orientation = current && box.orientations.indexOf(current.orientation) !== -1
      ? current.orientation : box.orientations.slice().sort()[0];
    var level = Core.placementsInSlot(base, slotId).length;
    var candidate = base.concat([{ boxCode: selectedBox, slotId: slotId, level: level, orientation: orientation }]);
    var report = Core.validatePlan(draft.hold, draft.boxes, candidate);
    if (report.ok) { preview = { placements: candidate }; conflicts = []; }
    else { preview = null; conflicts = report.conflicts; } // 失败：装载图回到已提交方案
    selectedBox = null;
    render();
  }

  function fillBoxForm(code) {
    var b = findBox(code);
    if (!b) return;
    boxForm.originalCode.value = b.code;
    boxForm.code.value = b.code;
    boxForm.code.readOnly = false;
    boxForm.portOrder.value = b.portOrder;
    boxForm.l.value = b.dims.l; boxForm.w.value = b.dims.w; boxForm.h.value = b.dims.h;
    boxForm.weight.value = b.weight; boxForm.maxLoad.value = b.maxLoad; boxForm.cogHeight.value = b.cogHeight;
    boxForm.ori_upright.checked = b.orientations.indexOf("upright") !== -1;
    boxForm.ori_side.checked = b.orientations.indexOf("side") !== -1;
    boxForm.fragility.value = b.fragility;
    boxForm.category.value = b.category;
    boxForm.forbidNeighbors.value = b.forbidNeighbors.join(",");
    renderBoxList();
  }

  function clearBoxForm() {
    boxForm.reset();
    boxForm.originalCode.value = "";
    boxForm.code.readOnly = false;
    $("#boxFormErrors").textContent = "";
    renderBoxList();
  }

  boxForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var orientations = [];
    if (boxForm.ori_upright.checked) orientations.push("upright");
    if (boxForm.ori_side.checked) orientations.push("side");
    var box = {
      code: boxForm.code.value.trim(),
      dims: { l: +boxForm.l.value, w: +boxForm.w.value, h: +boxForm.h.value },
      weight: +boxForm.weight.value,
      maxLoad: +boxForm.maxLoad.value,
      cogHeight: +boxForm.cogHeight.value,
      orientations: orientations,
      fragility: +boxForm.fragility.value,
      category: boxForm.category.value.trim(),
      forbidNeighbors: boxForm.forbidNeighbors.value.split(/[,，、\s]+/).filter(Boolean),
      portOrder: +boxForm.portOrder.value
    };
    var errors = Core.validateBox(box);
    var original = boxForm.originalCode.value;
    var duplicate = draft.boxes.some(function (b) { return b.code === box.code && b.code !== original; });
    if (duplicate) errors.push("箱号 " + box.code + " 已存在");
    if (errors.length) {
      $("#boxFormErrors").textContent = errors.join("；");
      return;
    }
    $("#boxFormErrors").textContent = "";
    if (original) {
      draft.boxes = draft.boxes.map(function (b) { return b.code === original ? box : b; });
    } else {
      draft.boxes = draft.boxes.concat([box]);
    }
    clearBoxForm();
    recompute(); // 箱体变更后重算；失败时已提交方案不变
  });

  $("#btnNewBox").addEventListener("click", clearBoxForm);

  $("#btnDeleteBox").addEventListener("click", function () {
    var code = boxForm.originalCode.value;
    if (!code) return;
    draft.boxes = draft.boxes.filter(function (b) { return b.code !== code; });
    clearBoxForm();
    recompute();
  });

  slotSelect.addEventListener("change", syncSlotInputs);

  $("#btnApplySlot").addEventListener("click", function () {
    var slot = draft.hold.slots.filter(function (s) { return s.id === slotSelect.value; })[0];
    if (!slot) return;
    var maxStack = +$("#slotMaxStack").value, maxWeight = +$("#slotMaxWeight").value,
        cog = +$("#cogLimit").value;
    if (!(maxStack >= 1) || !(maxWeight >= 1) || !(cog > 0 && cog <= 1)) return;
    slot.maxStack = maxStack;
    slot.maxWeight = maxWeight;
    draft.hold.cogRatioLimit = cog;
    recompute(); // 舱位变更后重算；失败时已提交方案不变
  });

  $("#btnGenerate").addEventListener("click", recompute);
  $("#btnCommit").addEventListener("click", commit);
  $("#btnDiscard").addEventListener("click", function () {
    draft = Core.clone(committed);
    preview = null; conflicts = []; selectedBox = null;
    clearBoxForm();
    render();
  });
  $("#btnReset").addEventListener("click", function () {
    committed = store.reset();
    draft = Core.clone(committed);
    preview = null; conflicts = []; selectedBox = null;
    clearBoxForm();
    render();
  });

  render();
})();
