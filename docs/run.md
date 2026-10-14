# 运行与开发说明

## 环境要求

- Windows 10/11
- Node.js ≥ 20（项目内便携版：`.runtime/node/`，或自行安装 LTS）
- Python ≥ 3.10 + Pillow（素材占位生成）；rembg（真人照片抠图，可选）
- 一个 Agent 后端：推荐已登录的 Kimi Code CLI（`kimi acp`）

## 安装

```bash
npm install
# electron/esbuild/koffi 的 postinstall 若被拦截：
npm install-scripts approve electron
npm install-scripts approve esbuild
npm install-scripts approve koffi
# 国内网络下载 electron 二进制：
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules/electron/install.js
```

## 命令行验证（核心链路）

```bash
npm run build:core

# 添加 ACP 后端（Kimi Code CLI）
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js backends test <backend-id>

# 添加角色
node dist/core/cli/index.js chars add --id char-1 --name 小甲 --line-a "你好呀！" --persona "你是活泼的桌面宠物"

# 单聊（流式）
node dist/core/cli/index.js chat --char char-1 "用一句话介绍你自己"

# 协作模式（多角色）
node dist/core/cli/index.js collab --chars char-1,char-2 --task "一起想个口号"
```

## 启动桌宠

```bash
npm start        # 构建并启动 Electron
```

- 托盘图标右键 → 打开设置 / 退出
- 桌宠页面：单击角色说台词 A；双击/右键「聊天」开聊天气泡；右键「协作任务」
- 设置页：导入照片生成角色、管理后端、权限与气泡折叠阈值

## 形象素材的 AI 生成（可选增强）

默认素材 = 照片抠图 + 本地变换派生帧（真实形象、姿态近似）。要达到
"四肢着地爬行"级姿态重绘，配置图像编辑 API（默认对接火山方舟 Seedream i2i）：

1. 设置页 → 全局 → 「图像 API Key」粘贴 ARK_API_KEY（DPAPI 加密存储）
2. 之后导入照片 / 「重新生成素材」自动走 AI 生成：每动作 1 张规范姿态图
   （12 个动作共 12 次调用，Seedream 约 0.2 元/次，免费额度 500 次）
3. 环境变量可覆盖：`DECKPET_IMAGE_BASE_URL` / `DECKPET_IMAGE_MODEL`
   （默认 `doubao-seedream-4-0-20260415`）

## 测试

```bash
npm test         # vitest：权限层/折叠/情绪匹配/编排路由（22 个用例）
```

## 目录

- `src/core/` —— 四层核心（types/permission/adapters/orchestrator/config）
- `src/cli/` —— 命令行入口
- `src/main/` —— Electron 主进程（窗口/IPC/Win32/托盘）
- `src/preload/` —— contextBridge（index.mts → index.mjs）
- `src/renderer/` —— 表现层（pet/settings/reader）
- `pipeline/` —— 素材管线（占位生成/抠图/AI 帧生成）
- `docs/adapter-api.md` —— 新增后端指南

## 数据位置

`%USERPROFILE%/.deckpet/`：`settings.json`（无密钥）、`keys/`（DPAPI 加密密钥）、`history/<charId>/session.jsonl`（会话历史）。
可用环境变量 `DECKPET_HOME` 覆盖。
