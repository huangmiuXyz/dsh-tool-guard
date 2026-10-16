# dsh-tool-guard

在**当前会话**里实时禁用「读操作」「写操作」「命令行」或「子智能体调用」，并连带它派生出的
全部子会话。四个开关在输入框工具条上，关掉哪个就禁哪个，**下一次工具调用**即被拦截，
模型收到的是：

```
此操作已被用户实时禁用：写操作「write」未执行，且不要再尝试调用。This operation is
disabled live by the user: the write tool "write" was not executed. Do not retry it —
continue with what the user allows, or tell the user what you need.
```

## 开关语义

**打开 = 允许**。四个开关默认全部打开，也就是一切照常；**关掉**某一个，那一类工具才被
禁用。这样默认状态不会看起来像受限，且"开关是开着的"读起来就是"这类工具能用"。

## 为什么是"实时"

拦截由 `ctx.tools.guard()` 完成。它是工具管线里**同步**、**单调**的一环，位于
`tools/pre-execute` 瀑布之后、真正派发之前，每次调用都重新读一遍内存里的四个布尔值。
所以翻转开关改变的正是下一次调用——不需要重载插件、不需要重启、不需要刷新页面。

`tools` 的服务契约本身就把这两条通道分了工：

> A denial that must hold regardless of order is a `ctx.tools.guard()`; a guard is
> synchronous, so a decision that must await something, such as asking the user,
> returns `ask` from `tools/pre-execute`.

这里的判定不需要 await 任何东西，所以它属于 guard；任何其它监听器的顺序都绕不过它。

## 归谁管

| 开关 | 关掉后拦住的工具 |
| --- | --- |
| **读操作** | `read` `glob` `grep` `read_image` `web_search` `web_fetch` `job_output` `job_list` `get_goal` `skill` `cordis_inspect_*` `load_workspace_dependencies` |
| **写操作** | `write` `edit` `plugin_manager` `present` `import_chat` |
| **命令行** | `bash` `pwsh` |
| **子智能体** | `subagent` `subagent_fork` `workflow` `send_message` `list_agents` `interrupt_agent` |
| **不归管** | 其余一切，包括 `todo_write`、`create_goal`、以及 MCP 与第三方插件的工具 |

### 命令行为什么单独一个开关

因为 shell 是**写工具的超级集**：`bash` 能写任意文件、删任意目录、连网络。所以拆开之后
有一个必须说清的非对称：

> **"关写、开命令行"并不能阻止写入**，它只是挡住了那几个以写命名的工具。

这是拆分的必然代价，不是疏漏——两个能力确实不同，各自都有单独要用的场景（只跑命令、
不让结构化文件工具动；或要 `ls`/`git status` 看情况、但不让 `write`/`edit` 落笔）。
菜单里就写在命令行那一行上，不留给用户去推断。**关命令行是强设置，关写是精确设置。**

### 子智能体为什么单独一个开关

因为它拦的是**另一种问题**。前三个开关管"这个会话自己做什么"；这一个管"这个会话能不能
**通过别人**做事"——创建子 agent、给它派活、看它、停它。

继承**不能**替代它。继承决定的是"子 agent 一旦存在，允许它做什么"；而这个开关决定的是
"能不能创建或驱动它"。两者都要：关掉子智能体开关之后，委派这件事本身就是关的，而不是
"委派出去了但干不了活"。

**归类规则是"这个工具作用于哪个 agent"，不是"拦住了方不方便"。** 所以下面几个都归在这里，
尽管从机制上看它们更像别的类：

- `send_message`（原本在写操作）——不改任何文件，做的是把活交给另一个 agent
- `list_agents`（原本在读操作）——只列本会话起的子 agent，读的是 agent 而不是文件
- `interrupt_agent`——停止一个子 agent

前两个如果留在原处，一个关掉了"委派"的用户仍然能**枚举和支使**已经存在的子会话，开关就
从它本该覆盖的那些工具漏出去了。

**`interrupt_agent` 是这几个里唯一有代价的**：拦住它就少了给失控委派收尾的顺手手段。它仍然
归在这里，因为规则是"作用于谁"而不是"拦了会不会不方便"——一个悄悄豁免掉"拦着麻烦"的工具
的开关，边界就没法说清，而这个菜单恰恰是逐行列明覆盖范围的。逃生口就是开关本身：把它打开，
再去停。一个手势，就在同一个控件上，而且不像豁免那样藏着东西。

### 其余取舍

- **判定按工具名**，不解析 `bash` 的命令行去猜里面是 `rm` 还是 `ls`——猜错两个方向都糟：
  `cat` 可以藏重定向，而"放 shell 过去"会让开关失去意义。
- **`todo_write` / `create_goal` 不归管。** 它们只动 agent 自己的记账，拦住只会打断工作。

**未知工具不归管**是刻意的：猜"写"会误伤无害工具，猜"读"会放过真正的写操作。要覆盖
MCP / 第三方工具，用宿主环境变量追加（逗号分隔），它**优先于**内置表，所以也能把
`bash` 挪到别类去：

```bash
DSH_TOOL_GUARD_READ=mcp__fs__read
DSH_TOOL_GUARD_WRITE=mcp__fs__write,mcp__fs__remove
DSH_TOOL_GUARD_SHELL=mcp__exec__run
DSH_TOOL_GUARD_AGENT=mcp__orchestrate__spawn
```

## 作用范围：单个会话 + 它派生的子会话

开关属于**一个会话**。在哪个会话的菜单里改，就只影响那个会话，以及它派生出来的全部子会话
（`subagent`、`workflow` 里 `agent()` 建出来的，以及它们再往下派生的一层层）。

为什么子会话必须一起管：`subagent` 和 `workflow` **本身不归三张表管**——它们不碰任何东西，
只负责创建子 agent。如果子会话不继承，那"派个子 agent 去干"就是一步绕过开关的路。

继承是**调用时沿父链向上解析**的，不是创建时把策略抄一份下去。这样带来两个性质：

- 在子 agent 已经存在之后才关掉父会话，子 agent **照样被拦**（不需要回头补登记）
- 放开父会话，所有没有自己策略的后代**一次性全部放开**

**就近生效**：如果子会话自己也有策略，用子会话的；否则用最近的那个受限祖先的。

**编辑来自子会话时，改的是它所属主会话的策略**——因为菜单里的开关就是那一条策略的投影。
界面上会写明"继承自主会话"，否则在子 agent 里放开限制、结果影响了主会话，会显得莫名其妙。

**跨会话互不影响**是有测试盯着的：限制 s1 不影响 s2，放开 s1 也不放开 s2。

### 没有 agent 的调用不归管

一次工具调用如果没有 `exec.agent`，就没有会话可以承载策略——用户不可能为它关过任何开关，
所以它按"不在范围内"处理，而不是隐式拒绝。

### 策略不持久化

策略只在本进程内存里。**重启 DSH 会把所有开关恢复成"全部允许"。** 这对一个应急开关是
刻意的——用户忘了的临时限制不应该活过重启——但也意味着它不是持久配置。

## 界面

输入框工具条右侧（`conversation.input.right` 列表槽，模型选择器旁边）一枚盾牌图标，
**不带文字**——工具条那一行还要放模型选择器和权限标签，一个标签只是重复 tooltip 已有的
信息。点开是四行开关：读操作 / 写操作 / 命令行 / 子智能体，各自带一行说明，命令行那行写明
它能读写文件。菜单打开时每 2 秒轮询一次宿主，所以别的窗口（第二个标签页）改了开关也能跟上；轮询
只在菜单打开时进行。会话自身是从槽位的 `sessionId` 座位上取的，每个请求都带着它。

**触发按钮的颜色随"是否有限制"走，不随"是否允许"走**：默认三个全开时它保持中性色，只有
至少一类被关掉才变色填充。否则"一切正常"会是最显眼的状态，而真正值得注意的——有东西被
关掉了——反而被淹没。

## 安装

```jsonc
// <profile>/package.json
{
  "dependencies": { "dsh-tool-guard": "link:/path/to/dsh-tool-guard" },
  "dsh": { "profile": { "bundles": [/* …, */ "dsh-tool-guard"] } }
}
```

然后 `pnpm install`，重启或刷新。`cordis.patch.yml` 那一行不能少：它是
`exports["./client"]` 唯一会被扫到的原因——`@deepseek-ai/dsh-client-modules` 只沿
Loader 自己的 entry 走，不给 Loader 行的包，它的浏览器 bundle 永远不会被送达页面。

**客户端半边会随 HMR 热更新，宿主半边不会。** 改 `src/client.js` 后刷新页面即可；改
`src/index.js`（守护逻辑、路由、开关语义）必须重启 DSH 才生效——它是 Node 侧模块，
Loader 不会重载已挂载的宿主插件。

### 版本错配会被明确指出，而不是静默失败

两个半边各自独立加载，所以"存了盘"经常等于"新客户端配旧宿主"。这在早期版本里表现为一个
很像 bug 的现象：**点击开关后它自己弹回去**。原因是新客户端发 `allowRead`，旧宿主只认
`denyRead`，对不认识的字段直接忽略，然后回一份没变的状态——客户端的乐观更新撑了 2 秒，
下一次轮询就把它抹掉了。

现在两边各自声明 `PROTOCOL`：

- 快照里带 `protocol` 字段，客户端发现对不上就**不显示开关**，直接说明"宿主端还是旧版本，
  请重启 DSH"——而不是给出一个看着能用、点了没用的开关。
- 宿主端收到一个**一个字段都不认识**的请求时返回 `409`，而不是 `ok`。这是同一个错配的
  另一个方向。
- 只有"字段认识但类型不对"才继续静默忽略（比如 `allowWrite: "yes"` 旁边的合法字段照常
  生效）。

**改动字段名或增删开关时，必须同时把两边的 `PROTOCOL` 加一**，否则这道保护会失声。自检里
有一条断言专门盯着两边的数字是否一致。

## 接口

宿主注册一条精确路由 `/dsh-tool-guard/state`。**会话是必填的**：GET 用查询参数，POST 用
body 字段。缺了它一律 `400`，因为"没有会话"的写入没有安全的默认解——落到全局就会违反
单会话作用域，猜一个会话更是错。

- `GET` `/dsh-tool-guard/state?sessionId=<id>`
  → `{ ok: true, state: { protocol, sessionId, ownerId, inherited, allowRead, allowWrite, allowShell, allowAgent, blocked: { read, write, shell, agent }, last } }`
- `POST` → body 为 `{ sessionId, allowRead?, allowWrite?, allowShell?, allowAgent? }`，只接受这四个布尔值。
  必须带 `x-dsh-tool-guard` 请求头——跨源页面可以不带预检地发"简单请求"，要求自定义头
  才是真正逼出预检、从而让浏览器拦下它的东西。
- `409` → body 里一个已识别字段都没有，即协议对不上（多半是宿主端落后）。错误信息里带
  `protocol` 数字和重启提示。

`ownerId` 是真正持有该策略的会话，`inherited` 表示它是否来自祖先。POST 落在 `ownerId` 上，
所以从子会话里改开关，改的就是那个主会话的策略——这正是"这个会话"对用户的意思。

`blocked` / `last` 只出现在快照里，界面不显示。留着是因为它们是"守卫到底有没有在跑"的
证据，排查时读一次 JSON 比在菜单上加一个计数字段更有用。

无 `webServer` 的部署（纯终端 profile）不会因此不激活：guard 照常注册，路由等服务出现
时再挂。同理 `agents` 也是可选的——没有它就只失去父子继承（每个会话各管各的），guard
本身照常工作，因为它是从 `exec.agent` 自己取会话的。

## 自检

```bash
node test/check.mjs
```

覆盖：清单与 patch、**两个半边都不引入任何运行时依赖**（本包用 `link:` 安装，多一个
import 就会开始解析失败）、三类归类规则与三张表的互斥性、guard 的开关语义（含"关写不
影响命令行"这条回归）、环境变量扩展、客户端不得出现已删除的文案，以及用**真实
`node:http` 服务器**跑通的整条链路（缺头 403、非法方法 405、非布尔字段不被强转、
POST 之后 guard 立刻拒绝）。
