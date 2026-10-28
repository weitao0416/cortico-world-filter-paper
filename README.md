# 滤纸 · Filter Paper

给 Coopanion（以及任何跑在 Cortico 上的 bot）用的一个 World 扩展：**交接笔记里，工具调用的机器日志不进去。**

## 它解决什么

Bot 的上下文快满时会写一份「交接笔记」留给下一轮，新一轮启动要整份载入——这份笔记是**每轮固定成本**。

原版写笔记时，会把工具调用的入参全文和回执全文一起抄进去。一次读文件就是上千字的正文，一次 `已按 enter。` 也占一行。实测某次真实交接：42 KB 笔记里，`[调用]` + `[回执]` 占 **47%**。

那些是运行日志，不是记忆。滤纸在交接那一刻把工具记录压扁，再交给原版渲染器。

## 规则

| 内容 | 处理 |
|---|---|
| 工具入参 | 只留开头 **60** 字（文件名、地址都在开头） |
| 成功回执 | 换成 `(完成)` |
| 只读类回执（`read_file` / `list_files` / `glob_files` / `grep_files`） | 留开头 **120** 字 |
| 失败回执（含 错误/失败/不存在/超时/ENOENT/denied/timeout…） | 保留 `失败：` + 开头 **90** 字 |
| 用户说的话、事件、人设、使用者档案 | **不动** |

它是筛子，不是摘要器——不生成新句子，所以不会编造记忆。

实测：一次交接从 **≈13,000 token 降到 ≈2,200 token**。

## 什么时候能用，什么时候用不了

先说清楚：**它只对「继承 cormini 的 bot」有效**，因为补丁打在 `Cormini.prototype.onHandoff` 上。Coopanion 桌面版内置的就是 cormini，所以对绝大多数人是「装上就行」。

| 情形 | 结果 |
|---|---|
| Coopanion 桌面版 + 默认 cormini 机器人 | **生效** |
| 自定义 bot 扩展，但继承了 cormini 且没自己覆写 `onHandoff` | **生效**（继承到打过补丁的原型方法） |
| 自定义 bot 自己覆写了 `onHandoff` | **不生效**——子类方法优先级高于原型，补丁被绕过 |
| 非 cormini 的独立 bot（如 `cortico-bot-xiaoshen` 一类） | **不生效**——它压根不走 cormini 的交接逻辑 |
| 宿主里没有 `bots/cormini/persona/persona.ts` | **不生效**——找不到可打补丁的地方 |
| 未来版本把 `renderHandoffNote`、`HANDOFF_NOTE_TYPE` 改名 | **失效**，但只降级为原版行为，不会写坏笔记 |

后三种情况都不会弄坏任何东西，最坏结果是「没省到 token」。

**已验证范围**：Coopanion **0.2.12 / 0.2.13**，Windows。macOS / Linux 上代码路径用的是 `node:path`，理论上同样成立，但没有在那里实跑过；用之前先看状态灯。

## 安装

### 从市场装

扩展页 → 搜索「滤纸」或 `filter-paper` → 安装 → **重启 Coopanion**。

### 手动装

```bash
cd <数据目录>/extensions
npm install cortico-world-filter-paper
```

然后在部署的 `config.json` 里启用：

```json
{
  "worlds": {
    "filter-paper": { "enabled": true }
  }
}
```

重启。World 的开关在 `home/<部署名>/config.json`，不在安装目录。

## 怎么确认生效

三层验证，从快到慢：

**1. 看状态灯（最快）**

扩展页 → World 总览 → 「滤纸」卡片：

- **绿灯** + 悬停「已生效；已筛 N 次交接」= 补丁打上了
- **红灯** = 没打上，悬停会写原因（找不到 cormini / 拿不到渲染器 / 加载失败……）

灯只能说明「补丁在」，不说明「交接真的被筛过」。要看后者得等第一次交接，`N` 会变。

**2. 看笔记大小（最实在）**

交接发生后，看 `workspace/handoffs/` 里新出的 `.md`：

- 之前动辄 30–40 KB，现在应该是个位数 KB
- 打开看内容：`[调用]` 后面只剩工具名和一小段参数，`[回执]` 大部分是 `(完成)`
- 失败的那几条仍然是 `失败：……`，原因没被抹掉

**3. 看日志**

`core.log` 里搜 `[filter-paper]`，正常有一行「补丁已生效（cortico 根：…）」；没打上会有一行「本轮没有打上补丁：<原因>」。

## 调整

### 笔记上限

默认取 `min(原预算, 6400)`，也就是说笔记最多 6,400 token（约 1 万字出头）。原预算 = 你的上下文预算 × `keepRatio`。

要改，设环境变量：

```bash
# Windows（临时，当前会话）
set HANDOFF_FILTER_TOKENS=4000

# Windows（永久，用户级）
setx HANDOFF_FILTER_TOKENS 4000

# macOS / Linux
export HANDOFF_FILTER_TOKENS=4000
```

改完重启 Coopanion。设成 `0` 或非数字会被忽略，回落到默认公式。

调小 = 笔记更短、丢的旧条目更多；调大 = 记得更多、省得更少。6000–8000 是常见区间。

### 三个阈值

`60 / 120 / 90` 字写死在 `index.js` 顶部：

```js
const ARG_CHARS = 60;    // 工具入参留多少字
const READ_CHARS = 120;  // 只读类回执留多少字
const FAIL_CHARS = 90;   // 失败回执留多少字
```

改完重启。目前没有做成配置项——如果你需要在界面上调，说一声。

## 卸载

**停用**：扩展页关掉「滤纸」的开关 → 重启。补丁只在内存里，重启就没了。

**删干净**：

```bash
cd <数据目录>/extensions
npm uninstall cortico-world-filter-paper
```

再从 `config.json` 的 `worlds` 里删掉 `filter-paper` 那一段。

**它没有往你的程序目录写过任何文件**，也没有改过手稿、工作区或数据。卸载不需要还原任何东西。

## 它怎么做到的

不重写渲染器，只在调用原版 `onHandoff` 之前把 snapshot 里的工具记录压扁：

```js
const after = function (snapshot, ctx) {
  return original.call(this, filterSnapshot(snapshot), ctx);
};
Cormini.prototype.onHandoff = after;
```

World 模块在 `loadExtensions` 阶段被 import，早于 Persona 实例构造，所以补丁一定赶在第一次交接之前。桌面版的派生类 `CoopanionPersona` 没有覆写 `onHandoff`，会继承到补丁后的原型方法。

**只在内存里改，不写任何程序文件。** 停用扩展或重启即恢复原样。

## 失效时的行为

两层兜底：

1. 找不到 `bots/cormini` 或拿不到 `renderHandoffNote` → **不打补丁**，原版照常工作（日志里有一行说明）。
2. 补丁内部抛异常 → 回落到原版 `onHandoff`。

最坏情况是「没省下 token」，不是「笔记写坏」。

## 仓库结构

```
cortico-world-filter-paper/
├── index.js           World 实现：定位程序根、打补丁、过滤工具记录
├── client.js          说明面板（浏览器端 ES 模块，无构建步骤）
├── client.css         面板样式
├── assets/
│   └── icon.svg       市场图标
├── README.md          本文件
├── LICENSE            AGPL v3 全文
└── package.json       清单：cortico.kind / api / icon / webUiClient
```

`index.js` 里几个入口：

| 导出 / 常量 | 作用 |
|---|---|
| `findCorticoRoot()` | 定位 `bots/cormini`；认 `COOPANION_CORTICO_ROOT`，否则从 `process.argv[1]` 向上找 |
| `state` | `{ patched, reason, handoffs, lastBudget }`，面板与灯读它 |
| `patch()` | 打补丁，幂等（`__filterPaper` 标记） |
| `create(ctx)` | World 入口，返回 `{ start, stop, webUi }` |

## 许可

AGPL-3.0-or-later。它运行时修改的是 AGPL 授权的 Cortico 代码，所以同许可发布。全文见 [LICENSE](./LICENSE)。
