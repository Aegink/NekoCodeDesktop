# oh-my-pi → NekoCode 工具移植清单

来源：`demo/oh-my-pi-main`（@oh-my-pi/pi-coding-agent，MIT，natives 18.3.2）。
下文路径默认相对 `demo/oh-my-pi-main/packages/coding-agent/src/`。

工作量标记：**S** ≤1 天 · **M** 2–5 天 · **L** 1–2 周 · **XL** 更久或需原生代码。

---

## 0. 先定的三件事（其余条目都依赖它们）

- [ ] **运行时差异**：omp 跑在 Bun 上，NekoCode 主进程是 Electron/Node。
  移植时要替换所有 `Bun.*`、`bun:sqlite`、`import x from "./a.md" with { type: "text" }`
  （改为 `node:fs` / `node:sqlite` / Vite `?raw`）。另外，omp 的 UI 全部在 `@oh-my-pi/pi-tui`
  （终端渲染），只拿工具逻辑，渲染要在 `src/renderer` 里重写成 React 行。
- [ ] **natives 策略（关键决策，先做 spike）**：很多高价值能力的核心在 Rust
  （`crates/`，约 27 万行）。两条路：
  - **A. 直接依赖 npm 上的 `@oh-my-pi/pi-natives` 预编译 N-API 包**。N-API 与 ABI 无关，
    理论上可直接在 Electron 主进程加载；它提供 6 个平台（win/mac/linux × x64/arm64）的预编译产物，
    JS 加载器里没有 Bun 专用调用。要验证：Electron 里能否加载、安装包体积、
    electron-builder `asarUnpack`、macOS 签名/公证、加载器默认往 `~/.omp/natives` 写文件的行为。
  - **B. 逐项用 TS 或现有 npm 库替代**（ripgrep 二进制、`@ast-grep/napi`、pdfjs 等）。
  - 建议：花 1 天做 A 的 spike。能用，则 hashline、进程内 grep/glob、PDF/HTML 转 Markdown、
    代码摘要都能以 M 级成本接入；不能用，这些条目大多退化为 XL 或只能放弃。
- [ ] **许可**：MIT，可移植，但要保留版权声明。拷贝的文件头部注明出处，
  并把 `THIRD-PARTY-NOTICES.txt` 中相关条目并入 NekoCode 的 notices（`pi-builtins` 内含 uutils、jaq 等第三方代码）。
- [ ] **落点约定**：工具实现放 `src/main/*`（`ToolDefinition`），在
  `pi/packages/prompt/<mode>/tools.json` 中按模式启用。尽量不改 `pi/`（它是上游快照，改动要在升级时重放）。

---

## 1. NekoCode 已有，无需移植（最多对齐细节）

| omp | NekoCode 现状 | 可借鉴的细节 |
| --- | --- | --- |
| `read` / `write` / `edit`（str_replace 模式） | pi 自带 read/write/edit | 见 §2、§3 的增强 |
| `grep` / `glob` | pi `grep`（运行时下载 rg）、`find`、`ls`、`stat` | §3 进程内实现，免下载 |
| `ast_grep` / `ast_edit` | `src/main/ast-tools.ts`（@ast-grep/napi） | omp 的 ast_edit 是"先预览、再接受"两步 |
| `bash` | bash / powershell / cmd（`command-shell.ts`） | §4 后台任务、PTY |
| `web_search` / `fetch` | `web-search.ts`（7 个提供方）、`web_fetch` | §2 专用站点解析、更多提供方 |
| `github` | `github-tool.ts` | §4 `pr://` 等 URL 方案 |
| `task` / `todo` / `ask` | workflow：`task` / `task_status` / `task_cancel` / `todo_write` / `question` | §4 带 schema 的 yield、todo 阶段 |
| `browser` | `browser_*` 6 个工具（Electron 自带 webview） | 不移植 puppeteer 版 |
| `computer` | `computer_*` 11 个工具 | 不移植 |
| checkpoints（文件） | 文件日志 + 检查点回滚 | 注意：omp 的 `checkpoint`/`rewind` 是**上下文**修剪，含义不同，见 §4 |
| 任务隔离 | Git worktree（`worktree-service.ts`） | 不移植 `pi-iso`（APFS/ProjFS 克隆） |
| `/collab` 分享会话 | 局域网 / Relay / WebUI / QQ Bot | 不移植 |
| ACP | NekoCode 作为 ACP **客户端**驱动外部 agent | omp 是 ACP **服务端**，见 §5 |
| hooks、MCP、skills、plugins、token 统计 | 均已有 | — |
| advisor（第二个模型旁观） | Fusion（lead + sidekick） | 见 §4，确认两者差异后再决定 |

---

## 2. P0 — 高价值、纯 TS、优先移植（已完成，2026-09-29）

- [x] **读取文档类文件**（read 增强）
  - 实现：`src/main/read-tool.ts`（同名覆盖 pi 的 read，普通文件仍交给 pi）、`read-formats.ts`、`sqlite-reader.ts`（移植自 omp，改用 `node:sqlite`）。
  - SQLite 选择器语法与 omp 一致；连接只读（`query_only`）。压缩包：zip 系列与 tar/tgz，可读取 `x.zip:成员路径`。
  - PDF 走 B 方案：新增依赖 `unpdf`（内置 pdf.js），支持 `doc.pdf:3` / `:2-5` 指定页码；扫描件会提示没有文字层。
  - docx/xlsx/pptx 是自写的轻量转换（直接解析 zip 里的 XML），没有搬 mammoth/markit；epub 暂不支持。
- [x] **合并冲突 `conflict://N`**
  - 实现：`src/main/conflicts.ts`（移植）、`write-tool.ts`（同名覆盖 pi 的 write）。
  - 冲突写入会上报每个真实文件的改前内容，检查点可以回滚；并调用写入范围检查，不会绕过 worker 的写入范围。
  - 比 omp 多一条规则：模型把整个函数（首尾各一行上下文）粘回来时，两行一起去掉。
- [x] **兼容其他工具的规则文件**
  - 实现：`src/main/foreign-rules.ts`，通过 `agentsFilesOverride` 注入。支持 Cursor、Windsurf、Cline、Copilot、Claude Code `.claude/rules`、`.agents/rules`、GEMINI.md，以及与 AGENTS.md 内容不同的 CLAUDE.md。
  - 按 glob 或描述生效的规则只进入一份一行一条的索引，由模型按需读取。设置页的"项目指令"里列出这些文件；agent 改了规则文件后会重建提示。
  - 未做：用户级（`~/.cursor` 等）规则、opencode / vscode 格式、omp 的 TTSR 条件字段。
- [x] **web_fetch 专用站点解析**
  - 实现：`src/main/web-scrapers/`（75 个文件原样搬来，另加 `compat.ts` / `dom.ts` 替代依赖）。首次使用时才加载，单个解析器报错时回退到通用抓取。
  - 去掉了 YouTube（要 yt-dlp）、Twitter（依赖 Nitter 镜像）、ReadTheDocs（需要完整 DOM）。另外 web_fetch 现在能读 PDF。
- [x] **更多搜索提供方**
  - key 类新增 jina、perplexity（Sonar API，附带回答）、kagi、firecrawl。
  - 账号类新增 `codex`（用 OpenAI Codex 登录）和 `gemini`（用 Antigravity 登录，走 Google Search grounding），实现在 `src/main/native-search.ts`，结果带模型写的回答和出处。
  - 未做：google / startpage / mojeek / ecosia 等免 key 抓取（与现有"只保留 DuckDuckGo"的决定一致），以及 anthropic / kimi / openrouter 的原生搜索。
- [x] **小而实用的守卫**
  - 实现：`src/main/tool-guards.ts`，在主会话和子代理的工具闸门里调用。
  - 拒绝编辑生成文件：规则移植自 `pi-edit` 的 Rust 实现，文件名模式加开头注释里的标记。
  - shell 拦截：包含 PowerShell 规则（Get-Content、Select-String、Set-Content 等）；管道下游、`tail -f`、输出到 `/dev/null` 都放行。
  - read 行选择器：`file:N`、`N-M`、`N+K`、`-N`、多段用逗号分隔、`:conflicts`。`:raw` / `:img` 依赖 hashline 与图片渲染，未做。

---

## 3. P1 — 高价值，但依赖 natives（取决于 §0 的 spike）

- [ ] **Hashline 编辑（按内容哈希锚点编辑）** — A：**M** / B：**XL**
  - `edit/`（TS 约 1.6k 行）+ `crates/pi-edit`（Rust 约 2.85 万行）。
  - README 实测：Grok Code Fast 1 通过率 6.7%→68.3%，Grok 4 Fast 输出 token −61%。
  - 建议做成按模型可选的编辑模式，与 pi 的 str_replace 并存；read 输出需要同时带上行哈希前缀（`hashlineFormatNumberedLines`）。
- [ ] **进程内 grep / glob** — A：**S–M**
  - natives 的 `grep` / `glob` / `fuzzyFind`，带文件系统扫描缓存（`docs/natives-text-search-pipeline.md`）。
  - 替代 pi 在运行时下载 rg：离线或国内网络下经常失败。
- [ ] **大文件摘要读取** — A：**S**
  - `tools/read-summary.ts` 使用 natives 的 `summarizeCode`：大文件返回结构化摘要，而不是整段内容。
- [ ] **HTML → Markdown** — A：**S**
  - natives 的 `htmlToMarkdown`，可替换 `web-content.ts` 现有的转换，质量和速度都更好。
- [ ] **原子拆分提交（`omp commit`）** — A：**L**
  - `commit/`（约 7.6k 行），重度依赖 natives 的 `vcs*`：git_overview、git_file_diff、git_hunk、split-commit，把改动拆成按依赖排序的原子提交。
  - NekoCode 目前只有 `commit_message` 模式。

---

## 4. P1 — 纯 TS，但工作量大或需要设计

- [ ] **LSP 工具** — **L**
  - `lsp/`（约 9.9k 行，无 natives）：诊断、跳转、引用、符号、重命名（走 willRenameFiles）、code action，
    以及"写入即检查"（writethrough：写文件后回传诊断）。
  - NekoCode 的 IDE 已经为 Monaco 带了语言扩展（`ide-extensions.ts`），但 agent 没有 LSP。
    可以考虑复用同一套语言服务器进程。
- [ ] **调试器（DAP）** — **L**
  - `dap/`（约 4k 行）+ `tools/debug.ts`：断点、单步、线程、栈、变量。
  - 需要用户本机有适配器（lldb-dap、dlv、debugpy、js-debug），NekoCode 要做检测和安装引导。
- [ ] **记忆系统升级** — **M**
  - `tools/memory-{retain,recall,reflect,edit}.ts`、`tools/learn.ts`、`tools/manage-skill.ts`、`memory-backend/local-backend.ts`、`memories/`。
  - NekoCode 现有 `memory(save|delete|list)`。建议只移植 local 后端，并加上"会话结束时压缩成 mental model、下次首轮加载"。
  - `learn` → 自动沉淀为 skill，可以和 NekoCode 的 skills 页联动。
- [ ] **子代理结构化输出** — **M**
  - `tools/yield.ts`、`tools/output-schema-validator.ts`、`tools/jtd-*.ts`：子任务按 JTD schema 返回对象，父代理直接读取字段。
  - 配合 `agent://<id>/path` 取字段（见下一条）。接入 NekoCode 的 `task` 工具。
- [ ] **内部 URL 方案** — **M–L**
  - `internal-urls/`：`pr://`、`issue://`、`agent://`、`skill://`、`memory://`、`conflict://`、`ssh://` 等 16 种，
    让 read/grep 等文件类工具统一访问它们。
  - 建议分批：先做 `pr://` / `issue://`（复用 `github-tool.ts`）和 `agent://`。
- [ ] **Stream rules（TTSR）** — **M**
  - 见 `docs/ttsr-injection-lifecycle.md`、`capability/rule*.ts`：规则平时不占上下文，模型输出命中正则时中断流、注入规则、从原处重试。
  - 需要挂到 pi 的流式层：先确认能否在 `agent-service.ts` 做，避免改 `pi/`。
- [ ] **Advisor（第二个模型逐轮审阅）** — **M**
  - `advisor/`，另见 `docs/advisor-watchdog.md`。
  - 先对比 Fusion 的 sidekick 做什么：若 Fusion 是"协作产出"，advisor 是"旁观纠错"，两者可以并存；否则合并为 Fusion 的一种模式。
- [ ] **上下文修剪工具 `checkpoint` / `rewind`** — **M**
  - `tools/checkpoint.ts`、`tools/context-notes.ts`：探索阶段结束后把一大段上下文折叠成一份报告。
  - 和 NekoCode 的"检查点"（文件回滚）同名，移植时必须改名，比如"上下文折叠"。
- [ ] **Code review 优先级与结论** — **S–M**
  - `/review` 并行派出审阅子代理，问题按 P0–P3 分级并给置信度，最后给出能否上线的结论。
  - 主要是提示词和汇总格式，可接到 NekoCode 的审查页。
- [ ] **bash 增强** — **M**
  - `tools/bash.ts`、`tools/bash-interactive.ts`、`tools/wait.ts`：后台任务、可选 PTY、`wait` / `hub` 管理长时间运行的进程。
  - 另见 `docs/bash-tool-runtime.md`。
- [ ] **todo 阶段** — **S**
  - `tools/todo.ts`：有序修改和阶段跟踪，对比现有 `todo_write` 补上缺的部分。

---

## 5. P2 — 可选，按需再做

- [ ] `eval`：持久化 Python / JS 内核，内核里可以回调 agent 的工具 — **XL**（`eval/` 约 1.8 万行，还要管理 Python 环境）
- [ ] `generate_image`（Gemini / GPT / Grok 生图）— **S–M**（`tools/image-gen.ts`）
- [ ] `tts` / `stt` — **M**（`tools/tts.ts`、`stt/`；stt 的本地模型依赖 sherpa-onnx 或 transformers，体积大）
- [ ] `security_scan`（Codex Security 云端扫描）— **M**，需要确认 NekoCode 的 Codex OAuth 是否有权限
- [ ] 魔法关键词 `ultrathink` / `orchestrate` — **S**（`docs/magic-keywords.md`）
- [ ] `/fresh`（重置提供方流状态，不动本地记录）— **S**
- [ ] Approval mode（按工具声明审批策略）— **M**（`tools/approval.ts`），与 NekoCode 的执行模式对齐
- [ ] ACP **服务端**模式（让 Zed 等编辑器驱动 NekoCode）— **L**
- [ ] Vibe mode（导演驱动 fast / good 两类 worker）— **M**（`tools/vibe.ts`、`docs/vibe-mode.md`）
- [ ] `ida`（IDA Pro 逆向）、`xd://` 设备式按需工具 — 低优先级

---

## 6. 不建议移植

- `pi-tui` 终端渲染、TUI 快捷键和主题：NekoCode 是 React UI。
- puppeteer 版 `browser`、`computer`、`browser-relay`：已有 Electron 实现。
- `pi-iso` 各类文件系统克隆隔离：已用 worktree。
- brush shell + 58 个进程内 builtins（`pi-shell` / `pi-builtins`，约 13.6 万行 Rust）：
  除非 §0 选 A，且想在 Windows 上提供不依赖 Git Bash 的 bash，否则不碰。**若选 A，可重新评估**。
- `pi-voice` / WebRTC、collab relay、IRC、stencil、OTLP 遥测、Hindsight / Mnemopi 记忆后端。
- 60+ 模型提供方：属于另一个议题，不在本清单范围。

---

## 7. 建议顺序

1. §0 natives spike + 许可声明
2. §2 全部（read 增强、conflict、规则兼容、站点解析、原生搜索、守卫）
3. 若 spike 成功：§3 hashline + 进程内 grep/glob + 摘要读取
4. §4 LSP → 记忆升级 → 结构化子代理 → 其余
5. §5 按用户反馈挑选
