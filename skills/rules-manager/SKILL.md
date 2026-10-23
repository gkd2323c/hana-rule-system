---
name: rules-manager
description: 管理行为规则（hana-rule-system App）：列出/读取/新建/修改/删除/启停规则、撤销上一次改动、排查规则未生效。触发场景：管理规则、新建规则、修改规则、改规则内容、开关规则、禁用规则、启用规则、撤销规则改动、规则注入、行为规则、规则面板操作、规则不生效排查。遇到任何与行为规则增删改查相关的需求，使用本技能直接操作数据目录工作副本。
---

# 规则管理（hana-rule-system）

管理 `hana-rule-system` App 里的行为规则。规则进**系统提示**（system prompt），模型按设定执行；
不是会话消息，模型不会把它当外部输入权衡要不要遵守。

## 数据布局

```
%USERPROFILE%\.hanako\app-data\hana-rule-system\rules\
├── <规则名>.md           启用
├── <规则名>.mdisabled    停用（开关 = 扩展名）
└── .history\             改动前的快照（撤销用）
```

- 规则 key = 文件名去扩展名；文件名即标题，首行 `# 标题` 由写入时自动对齐
- 开关 = 扩展名：`.md` 启用 ↔ `.mdisabled` 停用
- **包内不带任何规则**：规则是使用者自己的数据，没有出厂默认，也没有「恢复默认」这个动作
- 改错了能退回：每次增删改之前自动存一份快照，`undo` 可退回最近一次改动前

## 运行环境

Node 由 fnm 管理、不在 PATH 时，先取本机 fnm 的 node 路径（`fnm exec -- node -v` 可确认）；
node 在 PATH 时直接使用即可。

CLI 随 App 分发，位于：

```
%USERPROFILE%\.hanako\apps\hana-rule-system\cli.mjs
```

## 用法

```
node cli.mjs <action> [选项]
action: list | get | create | update | delete | toggle | history | undo
选项:
  -n, --name <名>            规则名
  -c, --content <文本>       规则全文（多行内容建议用 -f）
  -f, --content-file <路径>  从文件读全文（与 -c 互斥，优先）
  -e, --enabled <true|false> 目标状态
  -i, --id <快照id>          要撤销到的历史（默认最近一次）
  -d, --dataDir <路径>       数据目录（一般不用传）
```

### 示例（PowerShell）

```powershell
$cli = "$env:USERPROFILE\.hanako\apps\hana-rule-system\cli.mjs"

# 列出所有规则（含停用）
& node $cli list

# 读规则全文
& node $cli get -n "工具并发纪律"

# 新建规则（多行内容先写文件）
Set-Content -Path "$env:TEMP\rule.md" -Value "# 新规则`n- 要点一`n- 要点二" -Encoding utf8
& node $cli create -n "新规则" -f "$env:TEMP\rule.md"

# 更新
& node $cli update -n "新规则" -f "$env:TEMP\rule.md"

# 启停
& node $cli toggle -n "新规则" -e false

# 删除
& node $cli delete -n "新规则"

# 撤销上一次改动
& node $cli history
& node $cli undo
```

> 多行内容走 `-f` 文件方式，不要用 `-c` 压成一行——引号与换行容易出坑。

## 管理界面

App 贡献了一张整页卡「行为规则」，在宿主的页面导航里可进。界面与 CLI 操作同一份工作副本，
功能等价：新建、编辑、启停、删除、撤销上一版。

## 语义与注意

- **改动从下一个会话生效**：会话内清单是冻结的，一条会话用一份规则，中途改也不换。
  规则改动要开新会话才吃到——这不是缺陷，是既定事实：规则是这条会话的设定，
  冻结也保住了缓存前缀的字节稳定。
- **指纹**：清单标识 = 生效清单 sha256 前 16 位，内容实质变化才变。
- **命名**：规则名 ≤48 字符、不含路径分隔符与 `:*?"<>|`；创建即默认启用。
- **正文格式**：每行一条，渲染时统一加 `- ` 前缀；首行标题由写入时自动对齐。
- **排查规则未生效**：先 `list` 看规则状态（`.md` 是启用、`.mdisabled` 是停用），
  再 `get` 确认内容与预期一致；停用的规则不进清单。

## 安全边界

- 本技能只读写 App 数据目录 `rules/` 工作副本，不碰宿主安装目录与代码
- `undo` 只回退到快照里那一份，不做内容合并
- App 不自带规则：换台机器装这个 App，规则是空的，要用 CLI 或界面导入
