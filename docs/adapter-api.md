# 适配器接口文档：如何新增一个 Agent 后端

DeckPet 的后端接入是插件式的：**实现一个 `DriverFactory`，注册一次，核心代码零改动。**

## 1. 概念位置

```
表现层(renderer) → 编排层(Orchestrator) → 适配层(你的 Driver) → 权限层(PolicyEngine)
```

你的 driver 只跟 `AgentDriver` 接口和 `DriverContext` 打交道，不许 import UI，
不许绕过 `ctx.policy` 执行危险动作。

## 2. 实现步骤

### 2.1 实现 DriverFactory

```ts
// src/core/adapters/my-driver.ts
import type { AgentDriver, BackendConfig, DriverContext } from '../types.js';

export function createMyDriver(backend: BackendConfig, ctx: DriverContext): AgentDriver {
  return {
    type: 'my-backend',
    // 若协议支持原生 system prompt 设为 true；否则省略/设 false，
    // 编排层会自动把人设并入首条用户消息（ACP driver 就是这样）。
    supportsSystemPrompt: false,

    async test() {
      // 连通性自检，不消耗对话
      return { ok: true, detail: 'ready' };
    },

    async createSession(opts) {
      // opts: { characterId, workingDir?, systemPrompt? }
      return {
        id: 'session-id',
        async *prompt(text, popts) {
          // 流式产出 ChatChunk：
          yield { type: 'delta', text: '部分回复' };
          yield { type: 'status', text: '正在调用工具 xx' }; // 可选
          yield { type: 'done' };
          // 出错: yield { type: 'error', error: '...' };
        },
        async cancel() { /* 中断当前输出（AbortController / 杀子进程） */ },
        async dispose() { /* 释放资源 */ },
      };
    },
  };
}
```

### 2.2 注册

```ts
// src/core/adapters/index.ts 的 registerBuiltinDrivers() 里加一行，
// 或在你的插件入口里：
registerDriver('my-backend', createMyDriver);
```

幂等性由 `hasDriver()` 保证。注册后，设置界面/CLI 里 `type` 填 `my-backend` 即可使用。

### 2.3 配置字段

`BackendConfig` 通用字段：`command/args`（子进程类）、`baseUrl/model/apiKeyRef`（HTTP 类）、
`systemPrompt`（后端级提示词）、`options`（你的 driver 私有字段，任意 JSON）。

API Key 永远不明文进 settings.json：UI/CLI 会把 key 经 `KeyStore`（Windows DPAPI）
存成 `apiKeyRef`，你在 driver 里用 `await ctx.resolveSecret(backend.apiKeyRef)` 取明文。

## 3. 权限层纪律（强制）

driver 内任何下列动作必须先过 `ctx.policy.authorize()`，拒绝即中止：

| 动作 | kind |
|---|---|
| 读文件 | `fs.read`（带 `path`） |
| 写/删文件 | `fs.write`（带 `path`） |
| 执行命令/拉起子进程 | `shell.exec`（带 `command`） |
| 网络请求 | `net.fetch`（带 `url`） |

策略三档：`readonly`（只读）/ `ask`（每步弹窗确认）/ `auto`（自动执行），
另有目录白名单 `allowedDirs`、命令黑名单 `blockedCommands`、联网开关 `networkEnabled`、
内网豁免 `allowedLocalHosts`。权限按角色独立配置，编排层已做好合并，你只管调 authorize。

参考实现：
- `acp-driver.ts` —— stdio JSON-RPC 子进程 + fs/terminal 能力回调过权限层（最完整）
- `openai-http-driver.ts` —— 纯 HTTP 流式（SSE）
- `dsh-driver.ts` —— headless CLI JSONL 流式

## 4. ACP 后端接入说明（首选路径）

任何实现了 ACP（Agent Client Protocol）的 agent CLI 都能零代码接入：
在设置页/CLI 添加 `type=acp` 的后端，填启动命令即可：

```
backends add --type acp --name Kimi --command kimi --args "acp"
backends add --type acp --name Gemini --command gemini --args "--acp"
```

`kimi acp` 已实测可用。driver 会以 client 身份完成 initialize → session/new →
session/prompt，并把 agent 的 fs/terminal/permission 请求全部路由到权限层。
