// lib/rules.js — 规则清单的读取、渲染、块操作与管理操作。
//
// 规则是一份统一数据集：一个目录，一批文件，一个 key 一条规则。
// 开关用扩展名表达：`.md` 启用，`.mdisabled` 停用（同 key 的两种扩展名并存时，
// 停用优先，因为「停用」是更明确的动作）。
//
// 包内不带任何规则——规则是用户自己的数据，没有出厂默认，也没有「恢复默认」。
// 能救命的替代品是「撤销上一版」：每次增删改之前自动存一份快照。
//
// 渲染算法：
//   # 行为规则 → 按「## 标题」分节 → 正文每行加回 "- " 前缀 → 整体 trim
// 指纹 = 渲染后文本的 sha256 前 16 位。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DISABLED_EXT = ".mdisabled";

/** 规则块标记：用来在 system prompt 里定位并整体替换本 App 注入的内容。 */
export const BLOCK_OPEN = "<!-- hana-rule-system:begin -->";
export const BLOCK_CLOSE = "<!-- hana-rule-system:end -->";

/** 规则名合法性：不含路径分隔符与 Windows 保留字符。 */
const INVALID_NAME = /[\\/:*?"<>|]/;

export function isValidRuleName(name) {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= 48 &&
    !INVALID_NAME.test(name)
  );
}

/** 规则正文的首行标题对齐：把首行规范成 "# <name>"。 */
export function normalizeHeading(name, content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const first = lines[0] ?? "";
  if (/^#\s+\S/.test(first.trim())) lines[0] = `# ${name}`;
  else lines.unshift(`# ${name}`);
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

function ruleKey(filename) {
  return filename.replace(/\.mdisabled$/, "").replace(/\.md$/, "");
}

function isRuleFile(filename) {
  return filename.endsWith(".md") || filename.endsWith(DISABLED_EXT);
}

/**
 * 读一个规则目录，返回按 key 排序的规则列表。
 * 同一个 key 同时存在 `.md` 与 `.mdisabled` 时，停用优先。
 */
export function loadRules(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const files = entries.filter(isRuleFile);

  // 先读启用的，再读停用的；同名时停用覆盖启用。
  // 两遍扫描而不是一遍里判断：readdir 顺序不保证，
  // 一遍扫描时「后读入的赢」会随目录顺序漂移。
  const byKey = new Map();
  for (const pass of ["enabled", "disabled"]) {
    for (const filename of files) {
      const isDisabled = filename.endsWith(DISABLED_EXT);
      if ((pass === "enabled") === isDisabled) continue;
      const full = path.join(dir, filename);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        const raw = fs.readFileSync(full, "utf8");
        const key = ruleKey(filename);
        byKey.set(key, {
          key,
          title: key,
          enabled: !isDisabled,
          // 首行是标题行，正文从第二行起；去掉原有 "- " 前缀，由渲染统一加回。
          body: raw
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.trim())
            .filter(Boolean),
        });
      } catch {
        // 单个规则读失败不应拖垮整份清单。
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key, "zh-CN"));
}

/**
 * 渲染生效清单。
 * 只含启用的规则；正文每行统一加 "- " 前缀。
 */
export function renderManifest(rules) {
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) return "";
  const lines = ["# 行为规则", ""];
  for (const rule of enabled) {
    lines.push(`## ${rule.title}`, "");
    for (const entry of rule.body) {
      lines.push(`- ${entry.replace(/^-\s+/, "")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** 清单指纹：渲染后文本的 sha256 前 16 位。 */
export function manifestFingerprint(text) {
  if (!text) return null;
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 把清单包成带标记的块。标记 + 指纹是幂等与「改规则不累积」的依据：
 * 注入前先剥掉旧块，再追加新块，重复注入结果一致。
 */
export function buildBlock(manifestText, fingerprint) {
  if (!manifestText) return "";
  return [BLOCK_OPEN, `规则清单 ${fingerprint}`, manifestText, BLOCK_CLOSE].join("\n");
}

/**
 * 从既有 system prompt 里剥掉旧的规则块。
 * 保留块之外的一切内容——包括其他 App 注入的内容（powershell-tool 的环境提示等）。
 */
export function stripBlock(systemPrompt) {
  if (typeof systemPrompt !== "string" || !systemPrompt) return "";
  const start = systemPrompt.indexOf(BLOCK_OPEN);
  if (start < 0) return systemPrompt;
  const end = systemPrompt.indexOf(BLOCK_CLOSE, start);
  if (end < 0) return systemPrompt.slice(0, start).trimEnd();
  const before = systemPrompt.slice(0, start).trimEnd();
  const after = systemPrompt.slice(end + BLOCK_CLOSE.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n");
}

/**
 * 把规则块追加到 system prompt 末尾。
 *
 * 末尾而非开头：system prompt 整段位于缓存前缀的最前面，改动越靠后，
 * 越可能只影响尾部而不动前面稳定的人格说明。会话内清单冻结后字节不变，
 * 每轮都命中同一段前缀。
 */
export function appendBlock(systemPrompt, block) {
  const base = stripBlock(systemPrompt).trimEnd();
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

/* ───────────────────────── 管理操作 ───────────────────────── */

/** 规则的完整原文（含标题行）与开关状态。 */
export function readRule(dir, name) {
  for (const ext of [".md", ".mdisabled"]) {
    const full = path.join(dir, name + ext);
    try {
      if (fs.statSync(full).isFile()) {
        return { name, enabled: ext === ".md", content: fs.readFileSync(full, "utf8") };
      }
    } catch {
      // 不存在就试下一个扩展名。
    }
  }
  return null;
}

/** 写规则：内容落盘到 .md；enabled=false 时落到 .mdisabled。 */
export function writeRule(dir, name, content, enabled = true) {
  const normalized = normalizeHeading(name, content);
  const target = path.join(dir, name + (enabled ? ".md" : ".mdisabled"));
  const other = path.join(dir, name + (enabled ? ".mdisabled" : ".md"));
  fs.writeFileSync(target, normalized, "utf8");
  // 同名只留一份：另一种扩展名是上一状态，删掉。
  try {
    fs.unlinkSync(other);
  } catch {
    // 本来就没有另一份。
  }
  return { name, enabled, content: normalized };
}

/** 开关：只改扩展名，不动内容。 */
export function toggleRule(dir, name, enabled) {
  const current = readRule(dir, name);
  if (!current) throw new Error(`规则不存在：${name}`);
  const from = path.join(dir, name + (current.enabled ? ".md" : ".mdisabled"));
  const to = path.join(dir, name + (enabled ? ".md" : ".mdisabled"));
  fs.renameSync(from, to);
  return { name, enabled };
}

/** 删除规则。 */
export function deleteRule(dir, name) {
  let removed = false;
  for (const ext of [".md", ".mdisabled"]) {
    try {
      fs.unlinkSync(path.join(dir, name + ext));
      removed = true;
    } catch {
      // 本来就没有这一份。
    }
  }
  if (!removed) throw new Error(`规则不存在：${name}`);
  return { name };
}

/* ───────────────────────── 快照与撤销 ───────────────────────── */

const HISTORY_DIR = ".history";
const HISTORY_KEEP = 20;

/** 规则集的完整快照（原文 + 开关状态）。 */
export function snapshotRules(dir) {
  const rules = loadRules(dir).map((r) => ({
    name: r.key,
    enabled: r.enabled,
    content: readRule(dir, r.key)?.content ?? "",
  }));
  return { at: new Date().toISOString(), rules };
}

export function saveSnapshot(dir, snapshot) {
  const historyDir = path.join(dir, HISTORY_DIR);
  fs.mkdirSync(historyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(historyDir, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...snapshot, at: snapshot.at ?? stamp }, null, 2), "utf8");
  // 只留最近若干份，避免历史目录无限长。
  const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
    try {
      fs.unlinkSync(path.join(historyDir, old));
    } catch {
      // 删不掉的先放着。
    }
  }
  return file;
}

export function listSnapshots(dir) {
  const historyDir = path.join(dir, HISTORY_DIR);
  let files = [];
  try {
    files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(historyDir, f), "utf8"));
      return { id: f.replace(/\.json$/, ""), at: data.at, count: Array.isArray(data.rules) ? data.rules.length : 0 };
    } catch {
      return { id: f.replace(/\.json$/, ""), at: f, count: 0 };
    }
  });
}

/**
 * 写回快照里的规则：先清空现有规则，再写回快照里的。
 */
export function applySnapshot(dir, snapshot) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  for (const f of files) {
    if (f.endsWith(".md") || f.endsWith(DISABLED_EXT)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // 单个删不掉不阻断。
      }
    }
  }
  for (const r of snapshot.rules ?? []) {
    writeRule(dir, r.name, r.content, r.enabled);
  }
  return { restored: snapshot.rules?.length ?? 0 };
}

/* ───────────────────────── 会话内冻结 ───────────────────────── */

/**
 * 会话内冻结：一条会话用一份清单，规则在会话中途改也不换。
 *
 * 两条理由：
 *   1. 缓存——system prompt 整段是缓存前缀，冻结后每轮字节不变，命中同一段前缀。
 *   2. 语义——规则是这条会话的设定，不该中途换；规则改动从下一个会话生效。
 *
 * 读文件的时机因此只在会话第一次进来时。冻结之后不再读，也就不存在
 * 「检测到内容变了就重建」这条路：会话中途规则不动是既定事实，不是待修的缺陷。
 */
export function createSessionFreezer(dir) {
  const frozen = new Map();
  return {
    /** 该会话的规则块。首次调用时读盘并冻结，之后一直给同一份。 */
    blockForSession(sessionKey) {
      const key = sessionKey || "default";
      const cached = frozen.get(key);
      if (cached) return cached;
      const manifest = renderManifest(loadRules(dir));
      const block = buildBlock(manifest, manifestFingerprint(manifest));
      frozen.set(key, block);
      return block;
    },
    /** 当前生效清单（读盘，不受冻结影响）——管理界面与指纹展示用。 */
    currentManifest() {
      return renderManifest(loadRules(dir));
    },
  };
}
