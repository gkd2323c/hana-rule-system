# 行为规则（hana-rule-system）

HanaAgent v2 App。把行为规则注入**系统提示**（system prompt），而不是会话消息。附规则管理界面与 CLI。

规则是使用者自己的数据：App 不带任何规则，装上之后清单是空的，要自己写。

## 为什么不是会话消息

规则作为 custom 消息注入时，落在模型输入的 **user 侧**：模型读到的是「用户发来的一段
文本」，会把它当外部输入权衡要不要遵守。规则进系统提示就没有这个视角——模型没有
「这是注入、要不要执行」的余地。

## 安装

把整个目录放到 HanaAgent 的 App 目录下，文件夹名保持 `hana-rule-system`：

```
<HANA_HOME>/apps/hana-rule-system/
```

`<HANA_HOME>` 默认是用户目录下的 `.hanako`（Windows 即 `%USERPROFILE%\.hanako`）。
放好后重启宿主，在「设置 → 应用」里批准这个 App，并授予 `app/hooks.agent-before-start`
能力。

也可以从 Release 下安装包：

```bash
gh release download --repo <owner>/hana-rule-system
# 解压后把目录放进 <HANA_HOME>/apps/hana-rule-system/
```

`sdk/` 是 HanaAgent 宿主 SDK 的随包副本，让 App 不依赖宿主的 `node_modules`。升级宿主后
可以用新版本的副本覆盖它，不要手改。

## 管理规则

三处入口，操作同一份工作副本（唯一事实源）：

- **界面**：App 贡献的整页卡「行为规则」，在宿主的页面导航里可进。支持新建、编辑、启停、删除、撤销上一版
- **CLI**：`node cli.mjs <action>`，动作 `list | get | create | update | delete | toggle | history | undo`
- **技能**：随包提供 `rules-manager` 技能，说明 CLI 用法与排查口径

```bash
# 列出所有规则（含停用）
node cli.mjs list

# 新建规则（多行内容建议先写文件）
node cli.mjs create -n "新规则" -f ./rule.md

# 启停 / 删除
node cli.mjs toggle -n "新规则" -e false
node cli.mjs delete -n "新规则"

# 撤销上一次改动
node cli.mjs undo
```

## 规则数据

规则是一份统一数据集：一个目录，一批文件，一个 key 一条规则。

```
<app-data>/hana-rule-system/rules/
├── 甲.md            启用
├── 乙.mdisabled     停用（同 key 的两份并存时停用优先）
└── .history/        改动前的快照（撤销用）
```

- 文件名去扩展名 = 规则 key = 清单里的标题
- 首行是标题行，正文从第二行起；正文每行渲染时统一加 `- ` 前缀
- 清单指纹 = 渲染后文本的 sha256 前 16 位
- **包内不带任何规则**：规则是使用者自己的数据，没有出厂默认，因此也没有「恢复默认」
  这个动作。能救命的替代品是「撤销上一版」——每次增删改之前自动存一份快照，可退回
  最近一次改动前

规则在会话里渲染成：

```
# 行为规则

## 规则标题

- 正文一条
- 正文两条
```

## 实现要点

**通道。** `ctx.hooks.onDecision("agent/before-start", ...)`，返回 `{ systemPrompt }` 直接
替换系统提示本体。APPS.md 的契约：

| 词 | 调用数据 | 决定 | 所需授权 |
| --- | --- | --- | --- |
| `agent/before-start` | `prompt`、`systemPrompt` | `{ systemPrompt?, message? }` | `app/hooks.agent-before-start` |

选它而不是 `agent/pre-step` 插消息：前者改的是系统提示本体，不在会话记录里留任何
痕迹；后者每轮往模型输入投影里插一条消息，形态上仍接近「每轮附带一条规则」。

**不冲掉既有系统提示。** APPS.md 写明「宿主自身的裁决先运行，App 按注册顺序看到
此前有效修改」，所以这里拿到的 `systemPrompt` 已含其他 App 的改动，只能在其上追加。
替换靠标记块整体剥离，重复注入结果一致，改规则不累积。

**缓存前缀稳定。** 宿主给 provider 打的缓存断点在最后一条 user 消息上，system prompt
整段是它的前缀。规则块因此放在**末尾**而不是开头：放开头会让人格说明整段缓存作废，
放末尾只废掉尾部到断点这一段。

**会话内冻结。** 一条会话一份清单，规则在会话中途改也不换。两条理由：冻结后每轮字节
不变，命中同一段前缀；规则是这条会话的设定，不该中途换。规则改动从**下一个会话**生效
——这不是缺陷，是既定事实。

**关于漂移。** `agent/before-start` 的返回值只在请求期生效，不进会话建立时的基准，
宿主据此每轮报 `cache_contract_violation` / `drift_auto_renew`。这是宿主判据的问题
（[上游 issue 2824](https://github.com/liliMozi/openhanako/issues/2824)），不影响 provider
侧缓存命中——请求侧每轮字节相同，前缀就是稳定的。

## 开发

```bash
node test/rules.test.mjs
```

覆盖：禁用规则不入清单、同名停用优先、渲染字节稳定、指纹敏感、块含标记、不冲掉既有
系统提示、规则块在末尾、重复注入结果一致、改内容后旧块被剥离、剥离不伤及块外内容、
空清单不注入、管理操作（名校验、首行对齐、开关只改扩展名、删除清两种扩展名、快照可还原、
历史倒序、还原会清掉快照外的新规则、指纹随内容变化），以及会话内冻结（同一会话反复取块
字节相同、会话中途改规则该会话的块不变、新会话读到改动后的清单、当前清单读磁盘现状）。

静态校验：

```bash
node ~/.hanako/skills/hana-app-creator/scripts/validate_app.mjs --dir .
```

打安装包：

```bash
node scripts/pack.mjs
```

产物 `dist/app-hana-rule-system-<version>.zip` 与对应的市场条目 `entry.json`。

### 开发目录与部署目录

源码在仓库里，`<HANA_HOME>/apps/hana-rule-system/` 是**部署产物**，只由部署动作写，
不在里头开发——在那里改代码，一次卸载重装就是一次代码丢失（宿主不支持同 id 覆盖安装，
重装必须先卸载，而卸载删的是目录，不是版本历史）。

部署步骤：

1. 自检与静态校验全过
2. 停用旧 App：`PUT /api/extensions/app:hana-rule-system/enabled {"enabled": false}`
3. 把仓库内容复制到 `<HANA_HOME>/apps/hana-rule-system/`（复制而非移动，源码留在原地）
4. 启用 / 重新安装 App
5. **运行期数据在 `app-data/hana-rule-system/rules/`，不随部署覆盖**——换代码不丢规则

## 已知限制

- 启动检查（`validate_app.mjs --smoke`）在临时 AppHost 里报
  `no "sessionHooks" service`：该临时组合不挂 `hana-session-hooks` 单元。用同一个钩子的
  其他 App 同样过不了这一项，属校验环境限制。

## 许可

MIT，见 [LICENSE](LICENSE)。`sdk/` 是宿主 SDK 的随包副本，版权归其作者所有。
