# DeckPet — 桌面宠物 × Agent CLI 图形入口

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Windows 10/11 桌面宠物应用：每只桌宠都是一个活的 Agent。上传一张照片，角色被抠图并重绘成爬行小人，住在你的屏幕上——到处爬、爬你的窗口、挂在边缘——同时用文字气泡和你聊天（纯文字，无语音）。底层连接真实的 Agent 后端（经 ACP 的 Kimi Code CLI、DeepSeek Harness、或任意 OpenAI 兼容接口），所有写文件/执行命令都经过独立权限层把关。

## 特性

- **照片变桌宠**：rembg 抠图 + AI 姿态重绘（火山方舟 Seedream 图生图或任意 OpenAI 兼容图像 API），产出 15 个动作的全套素材（爬行、攀爬、悬挂、打滚、休息、三档口型、挥手、蹦跳、沮丧、思考、害怕、摔倒爬起）。没有图像 API 也能跑——内置程序化预置小人。
- **桌面运行时**：全屏透明置顶窗；空白处鼠标穿透，宠物身体可拖拽（带惯性抛出、摔倒再爬起）。实时 Win32 窗口枚举——沿窗口上沿爬、贴侧边攀爬、挂在屏幕顶端像单杠一样晃。
- **kimi web 式对话**：单击=预设台词；双击=聊天气泡，流式回复+口型动画，长回复自动折叠为精华版+「展开全部」阅读面板（Markdown+代码高亮）。DEV 开关显示工具调用过程；完整过程记录在本地 Web 日志页。
- **多 Agent 架构（严格四层）**：表现层(renderer) → 编排层（路由、协作模式：拆任务→汇报→汇总）→ 适配层（插件注册 driver：ACP / dsh / openai-http）→ 权限层（写文件/命令/联网的唯一闸门）。
- **权限**：只读/每步询问/自动执行，按角色独立；目录白名单、命令黑名单、联网开关、内网豁免。密钥走 Windows DPAPI 加密，绝不明文落盘。
- **Web 控制台**（`http://127.0.0.1:17890`）：上传照片、配密钥、调形象 prompt、形象版本存档/切换/删除、循环提醒管理。

## 快速开始（便携 exe）

1. 从 Releases 下载 `DeckPet-<版本>-portable.exe` 直接运行。
2. 首次启动：内置的**奶龙**桌宠直接出现在桌面上（无需任何配置），同时自动打开**设置页**：
   - 添加后端——最简单是装了 Kimi Code CLI 后用 `kimi acp`（类型 acp，命令 kimi，参数 acp），或填任意 OpenAI 兼容接口 + API Key；
   - （可选）填图像 API Key 开启 AI 姿态素材；
   - 上传照片 → 把奶龙换成你自己形象的桌宠。
3. 交互：**单击**=台词，**双击**=聊天，**拖拽**=拎起来（会害怕），拖到屏幕顶端松手=单杠悬挂，右键=菜单。托盘图标：隐藏/显示、设置、Web 控制台、退出。

环境要求：Windows 10/11 x64。ACP 后端需要本机已安装并登录对应 agent CLI（如 Kimi Code CLI）。AI 素材另需图像编辑 API key（推荐火山方舟，免费额度约 500 次）。

## 开发

需要 Node.js ≥ 20 和 Python ≥ 3.10（Python 可选：仅 rembg 抠图与 AI 素材后处理需要）。

```bash
npm install
npm run build
npm start        # 启动桌宠
npm test         # vitest：权限层/折叠/情绪/编排
npm run pack     # electron-builder → release/ 便携 exe
```

命令行验证 Agent 核心（无 GUI）：

```bash
npm run build:core
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js chars add --id char-1 --name 小甲 --line-a "爸爸"
node dist/core/cli/index.js chat --char char-1 "用一句话介绍你自己"
node dist/core/cli/index.js collab --chars char-1,char-2 --task "一起想个口号"
```

## 架构

```
src/renderer/   表现层（纯 DOM/TS，只用 window.deckpet IPC）
src/main/       Electron 主进程：窗口/IPC/Win32/托盘/Web 控制台
src/core/orchestrator/  路由、会话、多 Agent 协作调度
src/core/adapters/      Driver 插件注册表（acp / dsh / openai-http）
src/core/permission/    策略引擎——所有高危动作过 authorize()
pipeline/               素材管线（cutout.py / placeholder_gen.py /
                        frame_post.py / gen_frames.ts）
```

跨层契约集中在 `src/core/types.ts`、`src/core/ipc-contract.ts`、`src/core/sprite-contract.ts`。新增 Agent 后端见 [docs/adapter-api.md](docs/adapter-api.md)，运行细节见 [docs/run.md](docs/run.md)，打包见 [docs/packaging.md](docs/packaging.md)。

## 数据位置

- 设置与历史：`%USERPROFILE%/.deckpet/`（可用 `DECKPET_HOME` 覆盖）
- 密钥：`%USERPROFILE%/.deckpet/keys/`（DPAPI 加密）
- 素材：打包版在 `%APPDATA%/deckpet/assets/sprites/`，开发态在 `assets/sprites/`

## 说明

- DeepSeek Harness 处于 developer preview 且未经完整安全审计，其审批插件不作为唯一防线——DeckPet 权限层始终兜底。
- AI 生成素材消耗 API 调用（每角色全套 15 次）。每次重新生成前自动存档，可在 Web 控制台随时切回旧版。

## 许可证

MIT
