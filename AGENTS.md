# AGENTS.md — DeckPet 工程约定

## 架构红线

严格四层，禁止跨层调用：

```
src/renderer/  表现层（纯 DOM/TS，只用 window.deckpet，不得 import core 的 driver）
src/main/      Electron 主进程：窗口/IPC/Win32/托盘；ipc.ts 只做薄转发
src/core/orchestrator/  编排层：路由/会话/协作调度，只经 adapters/registry 拿 driver
src/core/adapters/      适配层：DriverFactory 插件注册；任何 fs/shell/net 动作先过权限层
src/core/permission/    权限层：唯一高危动作入口 authorize()
```

跨层契约集中在：
- `src/core/types.ts` —— 全部接口（AgentDriver/ChatChunk/PermissionPolicy/OrcEvent…）
- `src/core/ipc-contract.ts` —— IPC channel 白名单 CH + PreloadApi
- `src/core/sprite-contract.ts` —— 素材 manifest 格式（pipeline ↔ renderer）

改契约文件必须同步改所有实现方；renderer 新增通道先改 ipc-contract 再改 preload。

## 构建与测试

```bash
export PATH="$PWD/.runtime/node:$PATH"   # 便携 Node 24（系统未装 Node 时）
npm run build        # core(tsc) + main(tsc) + renderer(esbuild) + copy-static
npm test             # vitest，20 用例
npm start            # electron .
```

- TS 为 NodeNext/ESM（`"type":"module"`），相对 import 必须带 `.js` 后缀。
- preload 源文件是 `index.mts`（产出 `.mjs`，Electron ESM preload 要求）。
- 密钥只能走 `KeyStore`（DPAPI），禁止写进 settings.json。
- renderer 不用任何 UI 框架；样式用 TS 注入 `<style>`，不用外部 css 文件。

## 测试钩子

- `DECKPET_SMOKE=<png>` + `DECKPET_SMOKE_JS=<js>`：Electron 冒烟截屏/断言。
- `DECKPET_IMPORT_PHOTO=<path>`：跳过文件对话框直接导入。
- renderer 暴露 `window.__petDebug{lineA,chat,collab}` 供冒烟驱动。
- `scripts/mock-openai.mjs`：本地 mock 后端（localhost 需在设置的
  `globalPermission.allowedLocalHosts` 里豁免 `127.0.0.1` 才能访问）。
