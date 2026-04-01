# 学习笔记：CNB Claude Code 与 Node Network Devtools

日期: 2026-04-01

## 学习对象

这次实际学习了 3 个来源：

1. `https://cnb.cool/nfeyre/claudecode-src/-/wiki`
2. `https://cnb.cool/G_G/claude-code`
3. `https://github.com/GrinZero/node-network-devtools`

说明：

- `nfeyre/claudecode-src` 的 wiki 页面公开可访问，但 SSR 几乎不给正文。
- 我没有停在网页壳上，而是把两个 `cnb.cool` 仓库直接克隆到 `/tmp` 后读文件。
- 因此这份笔记基于真实仓库文件，而不是页面摘要。

## 一、`nfeyre/claudecode-src` 学到了什么

这个仓库更像：

- 一个面向安全研究的 `Claude Code` 源码镜像
- 重点在于帮助研究者理解真实系统的分层和模块边界
- 不是一个面向终端用户直接运行的封装版

它最有价值的是把 Claude Code 拆成了清晰的系统地图：

- `commands/`
- `tools/`
- `services/`
- `bridge/`
- `plugins/`
- `skills/`
- `remote/`
- `memdir/`
- `tasks/`
- `state/`
- `screens/`

从 `README.md` 可以看出，这个镜像最强调 4 件事：

1. 工具系统是第一等公民
2. 命令系统和 UI 是分开的
3. Bridge、Remote、Memory、Plugins、Skills 都是独立子系统
4. 整个 CLI 其实已经接近一个 agent operating system，而不是“会调用模型的终端工具”

对 `newagent` 最重要的启发：

- 不要把 agent shell 理解成 `REPL + prompt`
- 真正的外壳必须把 `command surface / tool runtime / state / memory / remote / plugins / skills` 拆开
- `Session Kernel` 和 `Tool Runtime` 必须是独立层，而不是散在主循环里

## 二、`G_G/claude-code` 学到了什么

这个仓库和上面的镜像不同。

它不是“研究镜像”，而是“把源码还原后真正重新构建、重新包装、重新投产”的工程版本。

我从它身上看到 4 个很重要的工程点：

### 1. 可运行分发层和源码研究层要分开

它仓库根目录是运行/分发壳：

- `Dockerfile`
- `entrypoint.sh`
- `scripts/`
- `skills-lock.json`

而真正的源码主体在：

- `claude-code-source/`

这个结构很对。

说明一个成熟项目会天然分成两层：

- `source kernel`
- `distribution shell`

对 `newagent` 的启发：

- 以后 `code/` 里做内核原型时，不要把打包、分发、部署、通道适配、平台入口全混进去
- 需要单独保留一层“运行与分发外壳”

### 2. 模型兼容层应该是适配器，不应该污染上层

这个仓库把 Anthropic 协议转 OpenAI 兼容 API 的逻辑定义为：

- 在 fetch / HTTP 层做协议转换
- 上层继续沿用原有类型和执行流

这是非常重要的外壳设计原则：

- 模型提供商切换应该尽量便宜
- provider compatibility 应该是适配层问题
- 不应该把上层 session / planning / tools / UI 改得面目全非

对 `newagent` 的启发：

- 以后模型层应设计 `provider adapter`
- 不要在 `Session Kernel` 里硬编码 Anthropic / OpenAI / Qwen 的协议差异

### 3. 运行模式分叉要显式

`entrypoint.sh` 明确区分：

- 普通 CLI 模式
- NPC / 平台触发模式

并根据环境变量决定走哪条执行路径。

这说明：

- “交互模式”
- “事件触发模式”
- “平台工作流模式”

应当是外壳层里的显式模式，而不是藏在业务逻辑里的 if/else。

对 `newagent` 的启发：

- 以后要支持多通道时，必须定义清楚 mode：
  - local interactive
  - local daemon
  - channel adapter
  - scheduled trigger

### 4. Skills 可以被当成运行时分发资产

这个仓库专门有 `skills-builder` 阶段，把 skills 在镜像构建时一起安装。

这件事很重要，因为它说明：

- skills 不只是提示词附件
- skills 可以被看作 shell 的运行时资产
- skills 的分发和锁定版本，本身就是项目管理对象

对 `newagent` 的启发：

- 未来应把 `skills` 视作与工具、配置同级的可部署对象
- skill registry / skill lock / skill install path 都值得单独设计

## 三、`node-network-devtools` 学到了什么

这个项目不是 agent shell。

它是一个开发期调试组件，用来：

- 把 Node.js 的网络请求映射进 Chrome DevTools 的 Network 面板
- 让 Node 进程的 HTTP/HTTPS/WebSocket 请求调试体验更像浏览器

它支持：

- HTTP/HTTPS 请求头、payload、响应体
- WebSocket 消息
- stack follow
- sourcemap 跳转
- CommonJS / ESM
- `undici.fetch`

它的价值不在“给最终用户一个能力”，而在于：

- 给开发者一个观测层
- 补足 Node 端网络请求的调试可见性

对 `newagent` 的启发：

- 网络可观测性应被视为 shell 开发期的重要辅助层
- 但它不是核心运行时的一部分
- 更适合做成 `dev-only instrumentation`

对 `newagent` 更具体的意义：

- 以后调试 model provider、web fetch、channel adapter、MCP transport 时，它会非常有用
- 尤其适合排查：
  - SSE 流断裂
  - WebSocket 通道异常
  - MCP 请求/响应异常
  - provider adapter 的协议转换问题

## 四、三者合起来的结论

这 3 个来源在 `newagent` 里分别对应不同层：

- `nfeyre/claudecode-src`
  - 提供系统地图
  - 适合拿来定义子系统边界

- `G_G/claude-code`
  - 提供可运行分发经验
  - 适合拿来设计 build / adapter / mode / skills distribution

- `node-network-devtools`
  - 提供开发期网络观测能力
  - 适合拿来增强外壳调试和可观测性

所以对 `newagent` 来说，最正确的吸收方式不是“抄一个大一统项目”，而是：

1. 用 `claudecode-src` 定义内核结构
2. 用 `G_G/claude-code` 学运行时包装和模式管理
3. 用 `node-network-devtools` 作为开发调试配件

## 五、对 `newagent` 的直接结论

### 应当保留的原则

- shell 内核和分发壳分层
- provider compatibility 走 adapter
- 运行模式显式建模
- skills 当成可部署资产
- 网络可观测性做成开发期增强层

### 不应现在就做的事

- 一上来做完整 Docker / 平台化交付
- 一上来做复杂远程 relay 架构
- 一上来复制完整命令面
- 一上来把调试设施混入核心内核

### 现阶段最该推进的 M1

继续坚持当前的 `M1 Terminal Shell Kernel`，但在设计上预留：

- `provider adapter`
- `mode switch`
- `skill runtime`
- `dev instrumentation`

这样未来扩展时不会推翻内核。
