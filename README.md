# DeckPet — Desktop Pets as a Front-End for Agent CLIs

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

A Windows 10/11 desktop-pet app where each pet is a living Agent: upload a photo,
the character is cut out and redrawn into a crawling sprite, and it lives on your
screen — crawling, climbing your windows, hanging from edges — while chatting
with you through speech bubbles (text only, no voice). Under the hood it talks to
real agent backends (Kimi Code CLI via ACP, DeepSeek Harness, or any
OpenAI-compatible endpoint), with a strict permission layer gating every file
write and shell command.

![status](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)

## Features

- **Photo → pet**: rembg cut-out + AI pose redraw (Volcengine Seedream i2i or any
  OpenAI-compatible image API), producing a full 15-action sprite set (crawl,
  climb, hang, roll, rest, 3 mouth shapes, wave, jump, sit-sad, think, scared,
  fall & get-up). No image API? Procedural preset sprites work out of the box.
- **Desktop runtime**: fullscreen transparent always-on-top window; empty pixels
  are click-through, the pet body is draggable (throws with inertia, trips and
  gets back up). Real-time Win32 window enumeration — pets crawl along window
  top edges, climb sides, hang from the screen top like a pull-up bar.
- **Chat like kimi web**: click = preset line; double-click = chat bubble with
  streaming replies, mouth animation, long-reply folding into a summary with an
  "expand all" reader panel (Markdown + code highlighting). DEV toggle shows
  tool-call process; full process is logged to a local web log page.
- **Multi-agent architecture (strict 4 layers)**: presentation (renderer) →
  orchestrator (routing, collab mode: task split → reports → summary) →
  adapters (plugin-registered drivers: ACP / dsh / openai-http) → permission
  layer (the only gate for fs-write / shell / network).
- **Permissions**: readonly / ask / auto per character, directory whitelist,
  command blocklist, network switch, intranet exemptions. Secrets are stored
  via Windows DPAPI — never in plaintext config.
- **Web console** (`http://127.0.0.1:17890`): upload photos, configure keys,
  tweak appearance prompts, save / switch / delete sprite versions, manage reminders.

## Quick Start (portable exe)

1. Download `DeckPet-<version>-portable.exe` from Releases and run it.
2. First launch: the built-in **Nailong** pet appears on your desktop right away
   (zero configuration), and the **Settings** page opens automatically:
   - Add a backend — easiest is `kimi acp` if you have Kimi Code CLI installed
     (type `acp`, command `kimi`, args `acp`), or any OpenAI-compatible endpoint
     with an API key.
   - (Optional) paste an image-API key for AI pose sprites.
   - Upload a photo → replace Nailong with a pet made from your own picture.
3. Interact: **click** = preset line, **double-click** = chat, **drag** = pick
   up (it panics), release at screen top = pull-up hang, right-click = menu.
   Tray icon: hide/show pets, settings, web console, quit.

Requirements: Windows 10/11 x64. For the ACP backend you need the corresponding
agent CLI installed and signed in (e.g. Kimi Code CLI). AI sprites additionally
need an image-edit API key (Volcengine Ark recommended; ~500 free calls).

## Development

Requires Node.js ≥ 20 and Python ≥ 3.10 (Python optional: only needed for
rembg cut-out and AI sprite post-processing).

```bash
npm install
npm run build
npm start        # launch the desktop pet
npm test         # vitest: permission engine, folding, emotion, orchestrator
npm run pack     # electron-builder → release/ portable exe
```

CLI validation of the agent core (no GUI):

```bash
npm run build:core
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js chars add --id char-1 --name Buddy --line-a "Hello!"
node dist/core/cli/index.js chat --char char-1 "Introduce yourself in one sentence"
node dist/core/cli/index.js collab --chars char-1,char-2 --task "Brainstorm a slogan"
```

## Architecture

```
src/renderer/   Presentation (DOM/TS only, talks via window.deckpet IPC)
src/main/       Electron main: windows / IPC / Win32 / tray / web console
src/core/orchestrator/  Routing, sessions, multi-agent collab
src/core/adapters/      Driver plugin registry (acp / dsh / openai-http)
src/core/permission/    Policy engine — every dangerous action passes authorize()
pipeline/               Sprite pipeline (cutout.py / placeholder_gen.py /
                        frame_post.py / gen_frames.ts)
```

Cross-layer contracts live in `src/core/types.ts`, `src/core/ipc-contract.ts`
and `src/core/sprite-contract.ts`. See [docs/adapter-api.md](docs/adapter-api.md)
to add a new agent backend, [docs/run.md](docs/run.md) for details, and
[docs/packaging.md](docs/packaging.md) for packaging notes.

## Data locations

- Settings & history: `%USERPROFILE%/.deckpet/` (override with `DECKPET_HOME`)
- Secrets: DPAPI-encrypted under `%USERPROFILE%/.deckpet/keys/`
- Sprites (packaged exe): `%APPDATA%/deckpet/assets/sprites/`; dev: `assets/sprites/`

## Notes

- DeepSeek Harness is in developer preview and not fully security-audited; its
  approval plugins are never the only line of defense — DeckPet's own
  permission layer always has the final say.
- AI-generated sprites cost API calls (15 per character set). Sprites are
  archived before every regeneration and can be restored/switched anytime from
  the web console.

## License

MIT
