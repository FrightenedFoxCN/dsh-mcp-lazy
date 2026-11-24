# dsh-mcp-lazy

**MCP 服务器按需启停 + 进程树回收**，给 DeepSeek Harness 用。

两件事：

1. `mcp_lazy` 工具在运行时开关 MCP 服务器，让启动只为真正要用的服务付费；
2. 一个通用垫片（`shims/reap.mjs`）修掉 MCP 服务器退出时的**孙进程泄漏**：harness 只关 stdio，不遍历进程树。

---

## 1. 为什么需要按需加载

`@deepseek-ai/dsh-mcp-client` 在 harness 启动时就连接每个配置的 MCP 服务器并做首次 tool discovery——README 原话是 "the server's tools appear **before the harness starts its first turn**"。所以每个服务器都在启动路径上，哪怕这个会话根本不用它。

本机实测（握手 = initialize + tools/list）：

| server | 握手+发现 | 关闭 |
|---|---|---|
| Wolfram（AgentTools） | **7.6–7.9s** | 挂死（见 §3） |
| Agda（agda-mcp-server） | 1.27s | 5ms |
| Rocq（rocq-mcp，opam exec） | 0.45s | 72ms |
| SMT（smt-mcp，python） | 0.17s | 28ms |
| Lean 4（uvx lean-lsp-mcp） | 0.32s | 54ms |

把重的那几个设成默认关闭，启动省掉约 9–10 秒。

## 2. `mcp_lazy` 工具

```
mcp_lazy action=status                    # 哪些服务器开着
mcp_lazy action=enable  server=wolfram    # 立即启动它
mcp_lazy action=disable server=wolfram    # 立即停止，释放进程与内存
```

**不做"首次调用才启动"**：模型必须先看到工具 schema 才能调用工具，所以服务器得先起来。于是走"一次显式开启"。

**工具可见性滞后一步**：`enable` 返回后，**当前 step 的工具列表还不含新工具**（此时调用会得到 `unknown tool`），下一次请求才出现。这是 DSH 的请求边界语义。提示词里应写"先 enable，下一步再调用"。

配置：

```yaml
- id: mcp-lazy
  name: '@local/dsh-mcp-lazy'
  config:
    toolName: mcp_lazy
    servers:
      - name: wolfram
        entry: include:wolfram-mcp    # 插件列表里的 entry id
        note: Wolfram Engine (Symbolic math, ~8s to start)
```

`entry` 是 Loader 的 entry id：来自 bundle patch 的行是 `include:<patch id>`，profile patch 里直接写的行就是 `<patch id>`。写错会在调用时返回 `no Loader entry`。

实现是 `loader.resolve(entry)` + `loader.update(entry, {...options, disabled})`。

## 3. 垫片：`shims/reap.mjs`

harness 关闭时只关 stdio，**不遍历进程树**。`uvx`/`npx`/`opam exec` 这类启动器把真正的服务器留成**孙进程**，父进程一死就 reparent 到 `init`。本机曾观察到一对 `uvx lean-lsp-mcp` 在其 DSH 父进程退出 12 分钟后仍存活（ppid=1）。

reaper 把真正的命令放在**独立进程组**里（`detached: true`），在 EOF/信号时 `kill(-pid)`，让启动器的孙进程一起死。

环境变量配置，一个文件服务所有服务器：

| 变量 | 含义 |
|---|---|
| `MCP_SHIM_COMMAND` | 要执行的命令（必需） |
| `MCP_SHIM_ARGS` | 参数 JSON 数组（默认 `[]`） |
| `MCP_SHIM_CWD` | 工作目录（默认继承） |
| `MCP_SHIM_GRACE_MS` | SIGTERM→SIGKILL 间隔（默认 2000） |

用法：

```yaml
command: /opt/homebrew/bin/node
args:
  - /absolute/path/to/dsh-mcp-lazy/shims/reap.mjs
env:
  MCP_SHIM_COMMAND: /opt/homebrew/bin/uvx
  MCP_SHIM_ARGS: '["--from","lean-lsp-mcp==0.33.0","lean-lsp-mcp"]'
  PATH: !!js "..."
```

实测：握手正常（22 tools / 395ms），退出 57ms，**无残留**。

## 4. Wolfram 启动为什么是 7.6 秒（拆解）

| 阶段 | 耗时 |
|---|---|
| 内核裸启动 | 1.10s |
| 加载 AgentTools paclet | +0.44s |
| `startMCPServer` 初始化 | **≈6s** |
| 其中 `runToolInitialization` | 对**所有工具**逐个跑 Initialization；Context 类工具要准备向量库（`preinstallVectorDatabases`） |
| 另有常量 | `$toolWarmupDelay = 5`（在 `tools/list` 之后触发） |

启动期间无网络连接（`lsof -i` 采样为空），所以不是网络问题；第一次工具调用只多 0.63s，所以预热不阻塞调用。配置层面没有跳过工具初始化的开关——**按需启停是唯一有效的手段**。

## 5. 一页速查：把重服务设成默认关闭

```yaml
- insert:
    - id: wolfram-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true          # ← 默认不启动
      config: { ... }
```

`disabled` 的初始状态**持久**（写在配置里），`mcp_lazy enable` 只对当前进程有效——重启回到配置状态。这是有意为之：临时开的东西不该变成永久成本。

## 6. 实测记录（2026-11-25）

| 动作 | 结果 |
|---|---|
| `status` | 4 个 `off` + `lean4 ON` |
| `enable wolfram` → 调用 | 7 工具，`Integrate[Sin[x]^2,{x,0,Pi}]` → `Pi/2` |
| `disable wolfram` → 进程 | shim + WolframKernel + **MathematicaServer** 全部回收，计数 0 |
| `enable agda` → 调用 | 73 工具，`agda_load` 891ms |
| `disable agda` → 进程 | reaper + `npm exec` + `node agda-mcp-server` 全部回收，计数 0 |

## 7. 限制

1. **工具滞后一步**（§2）：enable 之后要等下一次请求。
2. **`disable` 是立即卸载**：正在执行的调用会被中断。
3. **运行时开关不落盘**（§6）。
4. **垫片路径必须绝对**：`command`/`args` 里写本机绝对路径，换机器要改。
5. `loader` 服务缺失时 `enable`/`disable` 明确报错；`status` 仍可用（显示 `unknown`）。
