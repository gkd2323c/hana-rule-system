// test/rules.test.mjs — 规则注入与管理操作的不变量自检。
//
// 覆盖四组：
//   1. 读取与渲染：停用规则不入清单、同名停用优先、渲染字节稳定、指纹敏感。
//   2. 注入与幂等：不冲掉既有系统提示、规则块在末尾、重复注入结果一致、
//      改内容后旧块被剥离、剥离不伤及块外内容、空清单不注入。
//   3. 管理操作：名校验、首行对齐、开关只改扩展名、删除清两种扩展名、
//      快照可还原、历史倒序、还原会清掉快照外的新规则、指纹随内容变化。
//   4. 会话内冻结：同一会话反复取块字节相同、会话中途改规则该会话的块不变、
//      新会话读到改动后的清单、当前清单读磁盘现状。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRules,
  renderManifest,
  manifestFingerprint,
  buildBlock,
  stripBlock,
  appendBlock,
  isValidRuleName,
  readRule,
  writeRule,
  toggleRule,
  deleteRule,
  snapshotRules,
  saveSnapshot,
  listSnapshots,
  applySnapshot,
  createSessionFreezer,
  BLOCK_OPEN,
  BLOCK_CLOSE,
} from "../lib/rules.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-"));
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "甲.md"), "# 甲\n- 甲的一条\n", "utf8");
fs.writeFileSync(path.join(tmp, "乙.md"), "# 乙\n- 乙的一条\n", "utf8");
fs.writeFileSync(path.join(tmp, "关.md"), "# 关\n- 不生效\n", "utf8");
fs.renameSync(path.join(tmp, "关.md"), path.join(tmp, "关.mdisabled"));

console.log("规则读取与渲染");
check("禁用规则不进入清单", () => {
  const manifest = renderManifest(loadRules(tmp));
  assert.ok(!manifest.includes("不生效"), "禁用规则泄漏进清单");
  assert.ok(manifest.includes("甲的一条"), "启用规则缺失");
});
check("启用与停用同名时停用优先", () => {
  fs.writeFileSync(path.join(tmp, "乙.md"), "# 乙\n- 应该被停用版盖住\n", "utf8");
  fs.writeFileSync(path.join(tmp, "乙.mdisabled"), "# 乙\n- 停用版\n", "utf8");
  const manifest = renderManifest(loadRules(tmp));
  assert.ok(!manifest.includes("应该被停用版盖住"), "停用未优先");
  assert.ok(!manifest.includes("乙的一条"), "停用后仍进清单");
  fs.rmSync(path.join(tmp, "乙.md"));
  fs.rmSync(path.join(tmp, "乙.mdisabled"));
  fs.writeFileSync(path.join(tmp, "乙.md"), "# 乙\n- 乙的一条\n", "utf8");
});
check("渲染稳定：两次结果字节相同", () => {
  const rules = loadRules(tmp);
  assert.equal(renderManifest(rules), renderManifest(rules));
});
check("正文统一带 '- ' 前缀", () => {
  const manifest = renderManifest(loadRules(tmp));
  for (const line of manifest.split("\n")) {
    if (line.startsWith("-")) assert.ok(/^-\s+\S/.test(line), `前缀异常: ${line}`);
  }
});
check("指纹对内容敏感", () => {
  const a = manifestFingerprint("x");
  const b = manifestFingerprint("y");
  assert.equal(a.length, 16);
  assert.notEqual(a, b);
});

console.log("注入与幂等");
const manifestText = renderManifest(loadRules(tmp));
const block = buildBlock(manifestText, manifestFingerprint(manifestText));

check("块含标记与指纹", () => {
  assert.ok(block.includes(BLOCK_OPEN));
  assert.ok(block.includes(BLOCK_CLOSE));
  assert.ok(block.includes(manifestFingerprint(manifestText)));
});

const base = "原有系统提示第一段。\n\n## 工作区说明\n这里是人格说明，不能动。";

check("不冲掉既有系统提示", () => {
  const next = appendBlock(base, block);
  assert.ok(next.includes("原有系统提示第一段。"), "原有开头丢了");
  assert.ok(next.includes("这里是人格说明，不能动。"), "人格说明丢了");
});

check("规则块在末尾而非开头", () => {
  const next = appendBlock(base, block);
  assert.ok(next.trimEnd().endsWith(BLOCK_CLOSE), "规则块不在末尾");
  assert.ok(next.indexOf(BLOCK_OPEN) > next.indexOf("人格说明"), "规则块插到了前缀里");
});

check("重复注入结果一致（不累积）", () => {
  const once = appendBlock(base, block);
  const twice = appendBlock(once, block);
  const thrice = appendBlock(twice, block);
  assert.equal(once, twice, "第二次注入改变了结果");
  assert.equal(twice, thrice, "第三次注入改变了结果");
});

check("换内容后旧块被剥离（改规则不累积）", () => {
  const newBlock = buildBlock("新的清单内容", manifestFingerprint("新的清单内容"));
  const next = appendBlock(appendBlock(base, block), newBlock);
  assert.ok(!next.includes("一条"), "旧清单残留");
  assert.ok(next.includes("新的清单内容"), "新清单未生效");
  assert.equal((next.match(new RegExp(BLOCK_OPEN, "g")) || []).length, 1, "块数量不为 1");
});

check("剥离不伤及块外内容", () => {
  const stripped = stripBlock(appendBlock(base, block));
  assert.ok(stripped.includes("原有系统提示第一段。"));
  assert.ok(stripped.includes("这里是人格说明，不能动。"));
  assert.ok(!stripped.includes(BLOCK_OPEN));
});

check("空清单不注入", () => {
  const empty = buildBlock("", null);
  assert.equal(empty, "");
  assert.equal(appendBlock(base, empty), base);
});

check("既有提示里已有旧块时先剥离再追加", () => {
  const next = appendBlock(appendBlock(base, block), block);
  assert.equal((next.match(new RegExp(BLOCK_OPEN, "g")) || []).length, 1);
});

console.log("管理操作");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-mgr-"));

check("规则名校验拒绝路径与非法字符", () => {
  assert.equal(isValidRuleName("正常名"), true);
  assert.equal(isValidRuleName(""), false);
  assert.equal(isValidRuleName("a/b"), false);
  assert.equal(isValidRuleName("a:b"), false);
  assert.equal(isValidRuleName("x".repeat(49)), false);
});

check("写规则自动对齐首行标题", () => {
  writeRule(work, "新规", "没有标题行\n- 一条", true);
  const rule = readRule(work, "新规");
  assert.equal(rule.content.split("\n")[0], "# 新规", "首行未对齐");
  assert.ok(rule.content.includes("一条"));
});

check("写规则时同名另一种扩展名被清掉", () => {
  writeRule(work, "新规", "内容一", true);
  writeRule(work, "新规", "内容二", false);
  assert.equal(readRule(work, "新规").enabled, false);
  assert.equal(readRule(work, "新规").content.includes("内容二"), true);
  assert.equal(fs.existsSync(path.join(work, "新规.md")), false, "旧 .md 未清掉");
});

check("开关只改扩展名不动内容", () => {
  writeRule(work, "开关规", "# 开关规\n- 原内容\n", true);
  const before = readRule(work, "开关规").content;
  toggleRule(work, "开关规", false);
  const after = readRule(work, "开关规");
  assert.equal(after.enabled, false);
  assert.equal(after.content, before, "开关动了内容");
  toggleRule(work, "开关规", true);
  assert.equal(readRule(work, "开关规").enabled, true);
});

check("删除规则两种扩展名都清掉", () => {
  writeRule(work, "删规", "# 删规\n- x\n", true);
  writeRule(work, "删规", "# 删规\n- y\n", false);
  deleteRule(work, "删规");
  assert.equal(readRule(work, "删规"), null);
});

check("快照能还原改动前的规则集", () => {
  writeRule(work, "留规", "# 留规\n- 原始内容\n", true);
  const snap = snapshotRules(work);
  saveSnapshot(work, snap);
  writeRule(work, "留规", "# 留规\n- 改坏了\n", false);
  deleteRule(work, "留规");
  assert.equal(readRule(work, "留规"), null, "改动生效");
  applySnapshot(work, snap);
  const back = readRule(work, "留规");
  assert.ok(back, "快照没还原回来");
  assert.equal(back.enabled, true, "开关状态没还原");
  assert.ok(back.content.includes("原始内容"), "内容没还原");
});

check("快照历史可列出且按时间倒序", () => {
  writeRule(work, "历规", "# 历规\n- x\n", true);
  saveSnapshot(work, snapshotRules(work));
  writeRule(work, "历规", "# 历规\n- x2\n", true);
  saveSnapshot(work, snapshotRules(work));
  const list = listSnapshots(work);
  assert.ok(list.length >= 2, "历史条数不足");
  assert.ok(list[0].at >= list[list.length - 1].at, "未按时间倒序");
});

check("内容未变时不重复存快照", () => {
  const before = listSnapshots(work).length;
  saveSnapshot(work, snapshotRules(work));
  saveSnapshot(work, snapshotRules(work));
  assert.equal(listSnapshots(work).length, before, "同义快照占了撤销窗口");
});

check("一次连写之后仍能退回到连写之前", () => {
  const work2 = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-hist-"));
  writeRule(work2, "甲规", "# 甲规\n- 连写前的原文\n", true);
  const beforeBatch = snapshotRules(work2);
  saveSnapshot(work2, beforeBatch);
  // 模拟批量改规则：每改一次存一份，连续 30 次。
  for (let i = 0; i < 30; i += 1) {
    writeRule(work2, "甲规", `# 甲规\n- 第 ${i} 次改写\n`, true);
    saveSnapshot(work2, snapshotRules(work2));
  }
  const list = listSnapshots(work2);
  const oldest = list[list.length - 1];
  assert.ok(
    list.some((s) => s.id === beforeBatch.at.replace(/[:.]/g, "-")),
    `连写前的撤销点被挤掉了，现存 ${list.length} 份、最早 ${oldest?.id}`,
  );
  assert.ok(list.length <= 100, "保留上限失效");
});

check("还原快照会清掉快照之外的新规则", () => {
  const snap = snapshotRules(work);
  saveSnapshot(work, snap);
  writeRule(work, "新增规", "# 新增规\n- x\n", true);
  applySnapshot(work, snap);
  assert.equal(readRule(work, "新增规"), null, "新增规则没被清掉");
});

check("管理改动后清单指纹随之变化", () => {
  const before = manifestFingerprint(renderManifest(loadRules(work)));
  writeRule(work, "指纹规", "# 指纹规\n- 影响指纹\n", true);
  const after = manifestFingerprint(renderManifest(loadRules(work)));
  assert.notEqual(before, after, "指纹未随内容变化");
});

console.log("会话内冻结");
check("内容不变时重建出的块字节相同（缓存前缀稳定）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-freeze-"));
  writeRule(dir, "稳", "# 稳\n- 内容不变\n", true);
  const a = buildBlock(renderManifest(loadRules(dir)), manifestFingerprint(renderManifest(loadRules(dir))));
  const b = buildBlock(renderManifest(loadRules(dir)), manifestFingerprint(renderManifest(loadRules(dir))));
  assert.equal(a, b, "同样内容重建出了不同的块");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("同一会话反复取块字节相同", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-same-"));
  writeRule(dir, "冻", "# 冻\n- 初始内容\n", true);
  const freezer = createSessionFreezer(dir);
  const first = freezer.blockForSession("s1");
  const second = freezer.blockForSession("s1");
  assert.equal(first, second, "同一会话两次取到的块不同");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("会话中途改规则，该会话的块不变（冻结是既定事实）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-frozen-"));
  writeRule(dir, "冻规", "# 冻规\n- 旧内容\n", true);
  const freezer = createSessionFreezer(dir);
  const before = freezer.blockForSession("s1");
  writeRule(dir, "冻规", "# 冻规\n- 新内容\n", true);
  const after = freezer.blockForSession("s1");
  assert.equal(before, after, "会话中途规则被换掉了");
  assert.ok(after.includes("旧内容"), "冻结块内容被改");
  assert.ok(!after.includes("新内容"), "新内容提前进了会话");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("新会话读到改动后的清单", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-next-"));
  writeRule(dir, "换规", "# 换规\n- 旧内容\n", true);
  const freezer = createSessionFreezer(dir);
  const before = freezer.blockForSession("s1");
  writeRule(dir, "换规", "# 换规\n- 新内容\n", true);
  const next = freezer.blockForSession("s2");
  assert.notEqual(before, next, "新会话读到的还是旧清单");
  assert.ok(next.includes("新内容"), "新会话未吃到新内容");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("currentManifest 读当前磁盘现状（不受冻结影响）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rule-system-cur-"));
  writeRule(dir, "现规", "# 现规\n- 旧内容\n", true);
  const freezer = createSessionFreezer(dir);
  freezer.blockForSession("s1");
  writeRule(dir, "现规", "# 现规\n- 新内容\n", true);
  assert.ok(freezer.currentManifest().includes("新内容"), "当前清单未反映磁盘现状");
  fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项通过`);
