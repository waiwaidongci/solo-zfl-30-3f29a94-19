"use strict";
/*
 * 测试聚合入口：直接 `node tests/run-tests.js` 即可跑完全部测试。
 * 不依赖 `node --test` 的目录扫描/ glob 行为（Node 18/20/22 均可直接运行），
 * node:test 会在进程退出时自动执行已注册用例并以退出码反映成败。
 */
require("./planner-core.test.js");
require("./planner-regression.test.js");
