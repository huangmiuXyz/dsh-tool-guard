# dsh-tool-guard

在会话过程中**实时**禁用「读操作」「写操作」或「命令行」。三个开关在输入框工具条上，
关掉哪个就禁哪个，**下一次工具调用**即被拦截，模型收到的是：

```
此操作已被用户实时禁用：写操作「write」未执行，且不要再尝试调用。This operation is
disabled live by the user: the write tool "write" was not executed. Do not retry it —
continue with what the user allows, or tell the user what you need.
```

## 开关语义

**打开 = 允许**。三个开关默认全部打开，也就是一切照常；**关掉**某一个，那一类工具才被
禁用。这样默认状态不会看起来像受限，且"开关是开着的"读起来就是"这类工具能用"。

## 为什么是"实时"

拦截由 `ctx.tools.guard()` 完成。它是工具管线里**同步**、**单调**的一环，位于
`tools/pre-execute` 瀑布之后、真正派发之前，每次调用都重新读一遍内存里的三个布尔值。
所以翻转开关改变的正是下一次调用——不需要重载插件、不需要重启、不需要刷新页面。

`tools` 的服务契约本身就把这两条通道分了工：

> A denial that must hold regardless of order is a `ctx.tools.guard()`; a guard is
> synchronous, so a decision that must await something, such as asking the user,
> returns `ask` from `tools/pre-execute`.

这里的判定不需要 await 任何东西，所以它属于 guard；任何其它监听器的顺序都绕不过它。

## 归谁管

| 开关 | 关掉后拦住的工具 |
| --- | --- |
| **读操作** | `read` `glob` `grep` `read_image` `web_search` `web_fetch` `list_agents` `job_output` `job_list` `get_goal` `skill` `cordis_inspect_*` `load_workspace_dependencies` |
| **写操作** | `write` `edit` `plugin_manager` `present` `send_message` `import_chat` |
| **命令行** | `bash` `pwsh` |
| **不归管** | 其余一切，包括 `todo_write`、`create_goal`、`subagent`、`workflow`、以及 MCP 与第三方插件的工具 |

### 命令行为什么单独一个开关

因为 shell 是**写工具的超级集**：`bash` 能写任意文件、删任意目录、连网络。所以拆开之后
有一个必须说清的非对称：

> **"关写、开命令行"并不能阻止写入**，它只是挡住了那几个以写命名的工具。

这是拆分的必然代价，不是疏漏——两个能力确实不同，各自都有单独要用的场景（只跑命令、
不让结构化文件工具动；或要 `ls`/`git status` 看情况、但不让 `write`/`edit` 落笔）。
菜单里就写在命令行那一行上，不留给用户去推断。**关命令行是强设置，关写是精确设置。**

### 其余取舍

- **判定按工具名**，不解析 `bash` 的命令行去猜里面是 `rm` 还是 `ls`——猜错两个方向都糟：
  `cat` 可以藏重定向，而"放 shell 过去"会让开关失去意义。
- **`subagent` / `workflow` 不归管。** 它们自己不动任何东西；子 agent 的工具调用走的是
  同一个全局 guard，所以会在真正落笔的那一步被拦住。
- **`todo_write` / `create_goal` 不归管。** 它们只动 agent 自己的记账，拦住只会打断工作。

**未知工具不归管**是刻意的：猜"写"会误伤无害工具，猜"读"会放过真正的写操作。要覆盖
MCP / 第三方工具，用宿主环境变量追加（逗号分隔），它**优先于**内置表，所以也能把
`bash` 挪到别类去：

```bash
DSH_TOOL_GUARD_READ=mcp__fs__read
DSH_TOOL_GUARD_WRITE=mcp__fs__write,mcp__fs__remove
DSH_TOOL_GUARD_SHELL=mcp__exec__run
```

## 作用范围

**全局**（本 profile 的每个会话，包括子 agent）。guard 注册在普通 ctx 上就是全局的，
注册在 `agent.ctx` 上才只作用于单个 agent。这是"部署级"的开关——"先别动磁盘，我看点
东西"——所以选了全局。要做成单会话作用域，是把同一个 guard 注册到每个 `agent.ctx` 上，
属于叠加而不是重写。

## 界面

输入框工具条右侧（`conversation.input.right` 列表槽，模型选择器旁边）一枚盾牌图标，
**不带文字**——工具条那一行还要放模型选择器和权限标签，一个标签只是重复 tooltip 已有的
信息。点开是三行开关：读操作 / 写操作 / 命令行，各自带一行说明，命令行那行写明它能读写
文件。菜单打开时每 2 秒轮询一次宿主，所以别的窗口（官方插件页、第二个标签页）改了开关
也能跟上；轮询只在菜单打开时进行。

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
Loader 不会重载已挂载的宿主插件。这一点在开发时最容易误判：界面上的开关看起来动了，
而拦截规则其实还是旧的。

## 接口

宿主注册一条精确路由 `/dsh-tool-guard/state`：

- `GET` → `{ ok: true, state: { allowRead, allowWrite, allowShell, blocked: { read, write, shell }, last } }`
- `POST` → 同上，body 里只接受 `allowRead` / `allowWrite` / `allowShell` 三个布尔值，
  其余字段忽略。必须带 `x-dsh-tool-guard` 请求头——跨源页面可以不带预检地发"简单请求"，
  要求自定义头才是真正逼出预检、从而让浏览器拦下它的东西。

`blocked` / `last` 只出现在快照里，界面不显示。留着是因为它们是"守卫到底有没有在跑"的
证据，排查时读一次 JSON 比在菜单上加一个计数字段更有用。

无 `webServer` 的部署（纯终端 profile）不会因此不激活：guard 照常注册，路由等服务出现
时再挂。

## 自检

```bash
node test/check.mjs
```

覆盖：清单与 patch、**两个半边都不引入任何运行时依赖**（本包用 `link:` 安装，多一个
import 就会开始解析失败）、三类归类规则与三张表的互斥性、guard 的开关语义（含"关写不
影响命令行"这条回归）、环境变量扩展、客户端不得出现已删除的文案，以及用**真实
`node:http` 服务器**跑通的整条链路（缺头 403、非法方法 405、非布尔字段不被强转、
POST 之后 guard 立刻拒绝）。
