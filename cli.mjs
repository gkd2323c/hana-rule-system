// cli.mjs — 规则管理 CLI（hana-rule-system）
//
// 与 App 的管理界面操作同一份数据目录工作副本，是唯一事实源。
// 动作：list | get | create | update | delete | toggle | history | undo
//
//   node cli.mjs list
//   node cli.mjs get     -n "规则名"
//   node cli.mjs create  -n "规则名" -f "<文件>" [-e true|false]
//   node cli.mjs update  -n "规则名" -f "<文件>" [-e true|false]
//   node cli.mjs delete  -n "规则名"
//   node cli.mjs toggle  -n "规则名" -e true|false
//   node cli.mjs history
//   node cli.mjs undo    [-i <快照id>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRules,
  isValidRuleName,
  readRule,
  writeRule,
  toggleRule,
  deleteRule,
  snapshotRules,
  saveSnapshot,
  listSnapshots,
  applySnapshot,
} from "./lib/rules.js";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".hanako", "app-data", "hana-rule-system", "rules");

const USAGE = `用法：node cli.mjs <action> [选项]

action: list | get | create | update | delete | toggle | history | undo

选项:
  -n, --name <名>            规则名
  -c, --content <文本>       规则全文（多行内容建议用 -f）
  -f, --content-file <路径>  从文件读全文（与 -c 互斥，优先）
  -e, --enabled <true|false> 目标状态
  -i, --id <快照id>          要撤销到的历史（默认最近一次）
  -d, --dataDir <路径>       数据目录（默认 %USERPROFILE%\\.hanako\\app-data\\hana-rule-system\\rules）
`;

function parseArgs(argv) {
  const out = { action: null, name: null, content: null, contentFile: null, enabled: null, id: null, dataDir: null };
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) out.action = argv[i++];
  for (; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "-n" || arg === "--name") out.name = next();
    else if (arg === "-c" || arg === "--content") out.content = next();
    else if (arg === "-f" || arg === "--content-file") out.contentFile = next();
    else if (arg === "-e" || arg === "--enabled") out.enabled = next();
    else if (arg === "-i" || arg === "--id") out.id = next();
    else if (arg === "-d" || arg === "--dataDir") out.dataDir = next();
    else if (arg === "-h" || arg === "--help") out.action = "help";
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

function readContent(opts) {
  if (opts.contentFile) return fs.readFileSync(opts.contentFile, "utf8");
  if (opts.content !== null && opts.content !== undefined) return opts.content;
  return null;
}

function listRules(dir) {
  return loadRules(dir).map((r) => ({
    name: r.key,
    enabled: r.enabled,
    lines: r.body.length,
  }));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;

  if (!opts.action || opts.action === "help") {
    console.log(USAGE);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  switch (opts.action) {
    case "list": {
      const rules = listRules(dir);
      if (!rules.length) {
        console.log("（没有规则）");
        return;
      }
      for (const r of rules) {
        console.log(`${r.enabled ? "启用" : "停用"}  ${r.name}  (${r.lines} 行)`);
      }
      return;
    }

    case "get": {
      if (!opts.name) throw new Error("缺少 -n <规则名>");
      const rule = readRule(dir, opts.name);
      if (!rule) throw new Error(`规则不存在：${opts.name}`);
      console.log(rule.content.replace(/\s+$/, ""));
      return;
    }

    case "create": {
      if (!opts.name) throw new Error("缺少 -n <规则名>");
      if (!isValidRuleName(opts.name)) throw new Error("规则名不合法（≤48 字符，不含 \\ / : * ? \" < > |）");
      const content = readContent(opts);
      if (content === null || !content.trim()) throw new Error("缺少规则内容（-c 或 -f）");
      if (readRule(dir, opts.name)) throw new Error(`同名规则已存在：${opts.name}`);
      const enabled = opts.enabled === null ? true : opts.enabled === "true";
      saveSnapshot(dir, snapshotRules(dir));
      writeRule(dir, opts.name, content, enabled);
      console.log(`已新建：${opts.name}`);
      return;
    }

    case "update": {
      if (!opts.name) throw new Error("缺少 -n <规则名>");
      const existing = readRule(dir, opts.name);
      if (!existing) throw new Error(`规则不存在：${opts.name}`);
      const content = readContent(opts);
      if (content === null) throw new Error("缺少规则内容（-c 或 -f）");
      if (!content.trim()) throw new Error("规则内容为空");
      const enabled = opts.enabled === null ? existing.enabled : opts.enabled === "true";
      saveSnapshot(dir, snapshotRules(dir));
      writeRule(dir, opts.name, content, enabled);
      console.log(`已更新：${opts.name}`);
      return;
    }

    case "delete": {
      if (!opts.name) throw new Error("缺少 -n <规则名>");
      if (!readRule(dir, opts.name)) throw new Error(`规则不存在：${opts.name}`);
      saveSnapshot(dir, snapshotRules(dir));
      deleteRule(dir, opts.name);
      console.log(`已删除：${opts.name}`);
      return;
    }

    case "toggle": {
      if (!opts.name) throw new Error("缺少 -n <规则名>");
      const existing = readRule(dir, opts.name);
      if (!existing) throw new Error(`规则不存在：${opts.name}`);
      const enabled = opts.enabled === null ? !existing.enabled : opts.enabled === "true";
      saveSnapshot(dir, snapshotRules(dir));
      toggleRule(dir, opts.name, enabled);
      console.log(`已${enabled ? "启用" : "停用"}：${opts.name}`);
      return;
    }

    case "history": {
      const snapshots = listSnapshots(dir);
      if (!snapshots.length) {
        console.log("（没有历史）");
        return;
      }
      for (const s of snapshots) console.log(`${s.id}  ${s.at}  (${s.count} 条)`);
      return;
    }

    case "undo": {
      const snapshots = listSnapshots(dir);
      if (!snapshots.length) throw new Error("没有可撤销的历史");
      const wanted = opts.id ? snapshots.find((s) => s.id === opts.id) : snapshots[0];
      if (!wanted) throw new Error(`找不到那份历史：${opts.id}`);
      const data = JSON.parse(fs.readFileSync(path.join(dir, ".history", `${wanted.id}.json`), "utf8"));
      const result = applySnapshot(dir, data);
      console.log(`已撤销到 ${wanted.at}（${result.restored} 条规则）`);
      return;
    }

    default:
      throw new Error(`未知 action：${opts.action}`);
  }
}

try {
  main();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
