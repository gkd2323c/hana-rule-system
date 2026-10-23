// hana-rule-system — 把行为规则注入系统提示（system prompt），而不是会话消息。
//
// 为什么走 system prompt：
//   规则作为 custom 消息注入时落在模型输入的 user 侧，模型读到的是
//   「用户发来的一段文本」，会把它当外部输入权衡要不要遵守。规则进系统提示
//   就没有这个视角，模型没有「这是注入、要不要执行」的余地。
//
// 三条关键约束：
//   1. 不冲掉既有系统提示：APPS.md 写明「宿主自身的裁决先运行，App 按注册顺序
//      看到此前有效修改」，所以这里拿到的 systemPrompt 已含前序改动，只能在其上
//      追加；替换靠标记块整体剥离，保证重复注入结果一致。
//   2. 前缀字节稳定：宿主给 provider 打的缓存断点在最后一条 user 消息上，
//      system prompt 整段是它的前缀。规则块放末尾（不放开头），规则不变时
//      每轮字节不变，命中同一段前缀。
//   3. 会话内冻结：一条会话一份清单，规则在会话中途改也不换。两条理由：
//      system prompt 整段是缓存前缀，冻结后每轮字节不变；规则是这条会话的
//      设定，不该中途换。规则改动从下一个会话生效。
//
// 漂移：agent/before-start 的返回值只在请求期生效，不进会话建立时的基准，
// 宿主据此每轮报 cache_contract_violation / drift_auto_renew。这是宿主判据
// 的问题（上游 issue 2824），不影响 provider 侧缓存命中——请求侧每轮字节
// 相同，前缀就是稳定的。
//
// 数据布局：
//   dataDir/rules/    工作副本，唯一事实源；改动只落这里
//   开关 = 扩展名：.md 启用、.mdisabled 停用
//   包内不带规则：规则是用户自己的数据，没有出厂默认，别人装了也不该有。
//   改错了能退回去：每次管理操作前存一份快照，可撤销。

import { defineApp } from "./sdk/app-contract/server-client.js";
import fs from "node:fs";
import path from "node:path";
import {
  loadRules,
  renderManifest,
  manifestFingerprint,
  buildBlock,
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
} from "./lib/rules.js";

export const name = "hana-rule-system";

export default defineApp(async (sdk) => {
  const dataRoot = path.join(sdk.dataDir, "rules");

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch (error) {
    void sdk.logger.warn?.(`规则目录创建失败: ${error?.message || error}`);
  }

  // ── 会话内冻结 ─────────────────────────────────────────────
  // 一条会话一份清单，规则在会话中途改也不换：会话里读的第一次就是定稿。
  // 两条理由：system prompt 整段是缓存前缀，冻结后每轮字节不变；规则是这条
  // 会话的设定，不该中途换。规则改动从下一个会话生效。
  const freezer = createSessionFreezer(dataRoot);

  /** 改之前先存一份快照，改错了能退回去。 */
  function checkpoint() {
    try {
      return saveSnapshot(dataRoot, snapshotRules(dataRoot));
    } catch (error) {
      void sdk.logger.warn?.(`规则快照失败: ${error?.message || error}`);
      return null;
    }
  }

  // ── 注入 ───────────────────────────────────────────────────
  await sdk.hooks.onDecision("agent/before-start", (invocation) => {
    try {
      const base = typeof invocation?.systemPrompt === "string" ? invocation.systemPrompt : "";
      const session = invocation?.session || {};
      const sessionKey = session.sessionPath || session.sessionId || "default";
      const block = freezer.blockForSession(sessionKey);
      if (!block) return undefined;
      const next = appendBlock(base, block);
      if (next === base) return undefined;
      return { systemPrompt: next };
    } catch (error) {
      void sdk.logger.warn?.(`规则注入失败: ${error?.message || error}`);
      return undefined;
    }
  });

  // ── 管理 API ───────────────────────────────────────────────
  const rulesOf = () =>
    loadRules(dataRoot).map((r) => ({
      name: r.key,
      title: r.title,
      enabled: r.enabled,
      body: r.body,
    }));

  await sdk.routes.register((app) => {
    app.get("/health", (c) => c.json({ ok: true, app: "hana-rule-system" }));

    app.get("/api/rules", (c) => {
      const rules = rulesOf();
      return c.json({
        rules,
        total: rules.length,
        enabled: rules.filter((r) => r.enabled).length,
        fingerprint: manifestFingerprint(freezer.currentManifest()),
      });
    });

    app.get("/api/rules/:name", (c) => {
      const rule = readRule(dataRoot, c.req.param("name"));
      if (!rule) return c.json({ error: "规则不存在" }, 404);
      return c.json({ rule });
    });

    app.post("/api/rules", (c) => {
      const body = c.req.body?.() ?? {};
      const name = String(body.name ?? "").trim();
      if (!isValidRuleName(name)) {
        return c.json({ error: "规则名不合法（≤48 字符，不含 \\ / : * ? \" < > |）" }, 400);
      }
      const content = String(body.content ?? "").trim();
      if (!content) return c.json({ error: "规则内容为空" }, 400);
      if (readRule(dataRoot, name)) return c.json({ error: "同名规则已存在" }, 409);
      checkpoint();
      const written = writeRule(dataRoot, name, content, body.enabled !== false);
      return c.json({ ok: true, rule: written });
    });

    app.put("/api/rules/:name", (c) => {
      const name = c.req.param("name");
      const existing = readRule(dataRoot, name);
      if (!existing) return c.json({ error: "规则不存在" }, 404);
      const body = c.req.body?.() ?? {};
      const content = body.content === undefined ? existing.content : String(body.content);
      if (!content.trim()) return c.json({ error: "规则内容为空" }, 400);
      const enabled = body.enabled === undefined ? existing.enabled : body.enabled === true;
      checkpoint();
      const written = writeRule(dataRoot, name, content, enabled);
      return c.json({ ok: true, rule: written });
    });

    app.post("/api/rules/:name/toggle", (c) => {
      const name = c.req.param("name");
      const body = c.req.body?.() ?? {};
      const existing = readRule(dataRoot, name);
      if (!existing) return c.json({ error: "规则不存在" }, 404);
      const enabled = body.enabled === undefined ? !existing.enabled : body.enabled === true;
      checkpoint();
      try {
        const result = toggleRule(dataRoot, name, enabled);
        return c.json({ ok: true, rule: result });
      } catch (error) {
        return c.json({ error: String(error?.message ?? error) }, 400);
      }
    });

    app.delete("/api/rules/:name", (c) => {
      const name = c.req.param("name");
      if (!readRule(dataRoot, name)) return c.json({ error: "规则不存在" }, 404);
      checkpoint();
      try {
        const result = deleteRule(dataRoot, name);
        return c.json({ ok: true, rule: result });
      } catch (error) {
        return c.json({ error: String(error?.message ?? error) }, 400);
      }
    });

    app.get("/api/history", (c) => c.json({ snapshots: listSnapshots(dataRoot) }));

    app.post("/api/history/undo", (c) => {
      const snapshots = listSnapshots(dataRoot);
      if (!snapshots.length) return c.json({ error: "没有可撤销的历史" }, 404);
      const body = c.req.body?.() ?? {};
      const wanted = body.id ? snapshots.find((s) => s.id === body.id) : snapshots[0];
      if (!wanted) return c.json({ error: "找不到那份历史" }, 404);
      const file = path.join(dataRoot, ".history", `${wanted.id}.json`);
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        return c.json({ error: `历史读取失败：${error?.message || error}` }, 500);
      }
      const result = applySnapshot(dataRoot, data);
      return c.json({ ok: true, restored: result.restored, at: wanted.at });
    });
  });

  await sdk.logger.info(
    `hana-rule-system loaded: 规则注入已挂到 agent/before-start，管理 API 已注册（${rulesOf().length} 条规则）`,
  );
});
