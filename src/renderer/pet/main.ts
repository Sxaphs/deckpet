/**
 * 桌宠页面入口：初始化角色、RAF 主循环、命中测试/点击穿透、拖拽、
 * 单聊/协作事件流路由、右键菜单动作。
 * 样式全部由本文件注入 <style>，index.html 只留挂载点与 bundle.js。
 */
import type { OrcEvent, EmotionTag, CharacterConfig } from '../../core/types.js';
import type { WinRect } from '../../core/ipc-contract.js';
import { EMOTION_TO_ACTION } from '../../core/sprite-contract.js';
import { loadSpriteSet } from './sprite.js';
import { PetView } from './pet-view.js';
import { syncMouth } from './bubble.js';

// ─────────────────────────── 样式注入 ───────────────────────────

const CSS = `
html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
#app { position: fixed; inset: 0; }
.dp-pet { position: fixed; left: 0; top: 0; will-change: transform; z-index: 1; }
.dp-pet img { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-drag: none; }

/* 气泡：max-width 按规格 min(360px, 20vw)，内容区默认最多 6 行可滚动 */
.dp-bubble {
  position: fixed; z-index: 10;
  max-width: min(360px, 20vw);
  background: #fff; color: #222; border-radius: 10px;
  padding: 8px 10px;
  font: 13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  box-shadow: 0 2px 12px rgba(0,0,0,.3);
  opacity: 0; transition: opacity .4s;
  pointer-events: auto;
}
.dp-bubble-content {
  max-height: 9em; /* 约 6 行 */
  overflow-y: auto;
  white-space: pre-wrap; word-break: break-word;
}
/* 尾巴三角（::after），四个方向 */
.dp-bubble::after { content: ''; position: absolute; border: 8px solid transparent; }
.dp-place-top::after { bottom: -8px; left: 22px; border-top: 8px solid #fff; border-bottom: 0; }
.dp-place-bottom::after { top: -8px; left: 22px; border-bottom: 8px solid #fff; border-top: 0; }
.dp-place-left::after { right: -8px; top: 50%; margin-top: -8px; border-left: 8px solid #fff; border-right: 0; }
.dp-place-right::after { left: -8px; top: 50%; margin-top: -8px; border-right: 8px solid #fff; border-left: 0; }

.dp-bubble-inputrow { display: flex; gap: 6px; margin-top: 6px; }
.dp-bubble-input {
  flex: 1; min-width: 0; border: 1px solid #ccc; border-radius: 6px;
  padding: 4px 6px; font: inherit; outline: none;
}
.dp-btn {
  border: 1px solid #ccc; background: #f5f5f5; border-radius: 6px;
  padding: 3px 10px; font: inherit; cursor: pointer;
}
.dp-btn:hover { background: #e8e8e8; }
.dp-btn:disabled { opacity: .5; cursor: default; }
.dp-btn-stop { border-color: #d66; color: #c33; }
.dp-expand { margin-top: 6px; }
/* 聊天气泡手动关闭按钮（右上角 ×）与开发者模式开关 */
.dp-bubble-close {
  position: absolute; top: 2px; right: 6px; border: 0; background: none;
  font-size: 15px; color: #999; cursor: pointer; padding: 0 2px; line-height: 1.4;
}
.dp-bubble-close:hover { color: #333; }
.dp-bubble-dev {
  position: absolute; top: 3px; right: 24px; border: 1px solid #ddd; background: #f5f5f5;
  font-size: 10px; color: #888; cursor: pointer; padding: 0 5px; border-radius: 4px;
}
.dp-bubble-dev.on { background: #2d4a7a; color: #fff; border-color: #2d4a7a; }
/* 过程事件（仅 DEV 模式显示） */
.dp-status { color: #999; font-size: 11px; }

/* 右键菜单 */
.dp-menu {
  position: fixed; z-index: 100; min-width: 96px;
  background: #2b2b2b; color: #eee; border-radius: 6px;
  padding: 4px 0; font: 13px system-ui, "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
.dp-menu-item { padding: 6px 16px; cursor: pointer; white-space: nowrap; }
.dp-menu-item:hover { background: #3d6db5; }

/* 协作任务输入弹层 */
.dp-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.25);
  display: flex; align-items: center; justify-content: center;
}
.dp-dialog {
  background: #fff; border-radius: 10px; padding: 16px;
  width: min(420px, 80vw);
  font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif;
  box-shadow: 0 8px 32px rgba(0,0,0,.35);
}
.dp-dialog-title { font-weight: 600; margin-bottom: 8px; }
.dp-dialog textarea {
  width: 100%; box-sizing: border-box; min-height: 72px;
  border: 1px solid #ccc; border-radius: 6px; padding: 6px;
  font: inherit; resize: vertical;
}
.dp-dialog-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
`;

function injectStyles(): void {
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─────────────────────────── 入口 ───────────────────────────

const rng = Math.random;

async function bootstrap(): Promise<void> {
  injectStyles();
  const api = window.deckpet;
  if (!api) {
    // preload 不可用（如纯浏览器预览）：提示后退出，不崩
    document.body.textContent = 'deckpet preload API 不可用';
    return;
  }
  // 默认整窗点击穿透，悬停到宠物/气泡上再打开
  api.setClickable(false);

  // 窗口矩形障碍物 ~10Hz 推送
  let obstacles: WinRect[] = [];
  api.onRects((rs) => {
    obstacles = rs;
  });

  // 工作区（不含任务栏）：主进程推送，未收到时回退窗口全屏
  let workArea = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  api.onWorkArea((wa) => {
    workArea = wa;
    // 气泡 clamp 同步到工作区（不落任务栏后）
    for (const v of views) {
      v.bubble.boundsTop = wa.y;
      v.bubble.boundsBottom = wa.y + wa.height;
      v.bubble.boundsLeft = wa.x;
      v.bubble.boundsRight = wa.x + wa.width;
    }
  });
  const bounds = () => ({
    left: workArea.x,
    top: workArea.y,
    right: workArea.x + workArea.width,
    bottom: workArea.y + workArea.height,
  });
  const screenW = () => workArea.width;
  const screenH = () => workArea.y + workArea.height; // 物理地板 = 工作区底（任务栏上边）

  // ── 角色初始化：只上屏主桌宠（activeCharId，缺省为列表第一个，全新安装即奶龙）──
  const chars = await api.listCharacters();
  const { activeCharId } = await api.getSettings();
  const activeId = activeCharId ?? chars[0]?.id;
  const views: PetView[] = [];
  const byId = new Map<string, PetView>();
  const activeReq = new Map<string, string>(); // charId → 进行中的 reqId

  // ── 事件流路由 ──
  function routeEvent(ev: OrcEvent): void {
    if (ev.kind === 'done') return;
    if (ev.kind === 'error') {
      if (ev.charId) {
        const v = byId.get(ev.charId);
        v?.bubble.appendToken(`\n[错误] ${ev.error}`);
        v?.bubble.endStream('', '', false);
        v?.bubble.setOutputActive(false);
      }
      return;
    }
    const view = byId.get(ev.charId);
    if (!view) return;
    switch (ev.kind) {
      case 'speaker-start':
        view.bubble.beginStream();
        break;
      case 'token':
        view.bubble.appendToken(ev.text);
        break;
      case 'status':
        // 过程事件（工具调用等）：chat 模式不显示，DEV 模式才显示；
        // 完整过程已由编排层落盘，可在 Web 控制台 /logs 查看
        if (view.bubble.devMode) view.bubble.showStatus(ev.text);
        break;
      case 'emotion':
        view.triggerGesture(EMOTION_TO_ACTION[ev.emotion] ?? 'think', performance.now());
        break;
      case 'speaker-end':
        view.bubble.endStream(ev.fullText, ev.summary, ev.folded);
        view.bubble.setOutputActive(false);
        activeReq.delete(ev.charId);
        break;
    }
  }

  function wireEvents(reqId: string): void {
    api.onEvent(reqId, routeEvent);
  }

  // ── 单聊 ──
  function sendChat(view: PetView, text: string): void {
    const reqId = api.chat(view.char.id, text);
    activeReq.set(view.char.id, reqId);
    view.bubble.setOutputActive(true);
    wireEvents(reqId);
  }

  // ── 协作任务弹层 ──
  /** 协作集合：所有角色限时爬向屏幕底部中央的集合点（"开会"可视化） */
  function gatherForCollab(): void {
    const now = performance.now();
    const cx = workArea.x + workArea.width / 2;
    const spread = 90;
    views.forEach((v, i) => {
      const offset = (i - (views.length - 1) / 2) * spread;
      v.pet.meetTarget = { x: cx + offset, until: now + 8000 };
    });
  }

  function startCollab(task: string): void {
    const reqId = api.collab(task, views.map((v) => v.char.id));
    for (const v of views) activeReq.set(v.char.id, reqId);
    gatherForCollab();
    wireEvents(reqId);
  }

  function openCollabDialog(): void {
    if (!views.length) return;
    const overlay = document.createElement('div');
    overlay.className = 'dp-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'dp-dialog';
    const title = document.createElement('div');
    title.className = 'dp-dialog-title';
    title.textContent = '协作任务（所有角色参与）';
    const ta = document.createElement('textarea');
    ta.placeholder = '描述一下要大家合力完成的任务…';
    const btns = document.createElement('div');
    btns.className = 'dp-dialog-btns';
    const ok = document.createElement('button');
    ok.className = 'dp-btn';
    ok.textContent = '开始';
    const cancel = document.createElement('button');
    cancel.className = 'dp-btn';
    cancel.textContent = '取消';
    btns.append(cancel, ok);
    dialog.append(title, ta, btns);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    ta.focus();

    const close = () => overlay.remove();
    cancel.addEventListener('click', close);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close();
    });
    ok.addEventListener('click', () => {
      const task = ta.value.trim();
      if (!task) return;
      close();
      startCollab(task);
    });
  }

  // ── 台词 A ──
  async function doLineA(view: PetView): Promise<void> {
    try {
      const { text, emotion } = await api.lineA(view.char.id);
      view.bubble.showLineA(text);
      view.triggerGesture(EMOTION_TO_ACTION[emotion as EmotionTag] ?? 'think', performance.now());
    } catch {
      /* 后端不可用时静默 */
    }
  }

  /** 热替换形象：原地重建视图（保留当前位置），供右键菜单/素材推送复用 */
  async function refreshView(c: CharacterConfig, keepPos?: { x: number; y: number }): Promise<void> {
    const existing = byId.get(c.id);
    const pos = keepPos ?? (existing ? { x: existing.pet.x, y: existing.pet.y } : undefined);
    if (existing) {
      existing.root.remove();
      views.splice(views.indexOf(existing), 1);
      byId.delete(c.id);
    }
    const v = await addView(c);
    if (pos) {
      v.pet.x = pos.x;
      v.pet.y = pos.y;
    }
  }

  // ── 创建 PetView ──
  const margin = 60;
  async function addView(c: CharacterConfig): Promise<PetView> {
    const sprites = await loadSpriteSet(c);
    const view = new PetView(
      c,
      sprites,
      {
        onOpenChat: (v) => {
          // 双击进聊天：取消本次单击待触发的台词
          const t = pendingLineA.get(v);
          if (t) {
            clearTimeout(t);
            pendingLineA.delete(v);
          }
          v.bubble.enterChatMode();
        },
        onOpenCollab: () => openCollabDialog(),
        onRefreshSprite: (v) => void refreshView(v.char),
        onOpenSettings: () => api.openSettings(),
      },
      margin + rng() * Math.max(1, screenW() - margin * 2),
      screenH(),
      rng,
    );
    // 气泡回调
    view.bubble.onSend = (text) => sendChat(view, text);
    view.bubble.onStop = () => {
      const r = activeReq.get(view.char.id);
      if (r) api.cancel(r, view.char.id);
      view.bubble.setOutputActive(false);
    };
    view.bubble.onExpand = (fullText, title) => api.openReader(view.char.id, fullText, title);
    // 聊天开/关 → 切换窗口可聚焦（修输入框/IME 错位到屏幕左上角的问题）
    view.bubble.onChatToggle = (on) => api.setChatFocus(on);

    document.body.appendChild(view.root);
    views.push(view);
    byId.set(c.id, view);
    return view;
  }

  for (const c of chars) {
    // 启动只显示主桌宠；其他角色可在使用中新增（导入/协作），下次启动仍只显示它
    if (c.id === activeId) await addView(c);
  }

  // 角色热刷新：导入照片 / 删除 / 重新生成素材后免重启生效
  api.onCharactersChanged(async (latest, spriteIds) => {
    const ids = new Set(latest.map((c) => c.id));
    // 移除已删除的角色
    for (const v of [...views]) {
      if (!ids.has(v.char.id)) {
        v.root.remove();
        views.splice(views.indexOf(v), 1);
        byId.delete(v.char.id);
      }
    }
    // 新增角色；配置变化或素材被重生成（spriteIds）的角色原地重建（保留位置）
    for (const c of latest) {
      const existing = byId.get(c.id);
      const stale =
        !existing ||
        spriteIds.includes(c.id) ||
        JSON.stringify(existing.char) !== JSON.stringify(c);
      if (stale) await refreshView(c);
    }
  });

  // ── 命中测试 → 点击穿透 ──
  let lastMouse = { x: -1, y: -1 };
  let clickable = false;
  let lastHoverCheck = 0;

  function hoverCheck(now: number): void {
    if (now - lastHoverCheck < 120) return; // 节流
    lastHoverCheck = now;
    if (lastMouse.x < 0) return;
    // 拖拽中/菜单展开中强制可点击，确保 pointerup 与菜单点击必定送达
    const dragging = views.some((v) => v.isDragging());
    const menuOpen = views.some((v) => v.isMenuOpen());
    const over = dragging || menuOpen || views.some((v) => v.hitTest(lastMouse.x, lastMouse.y));
    if (over !== clickable) {
      clickable = over;
      api.setClickable(over);
    }
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      lastMouse = { x: e.clientX, y: e.clientY };
      hoverCheck(performance.now());
    },
    true, // forward:true 转发进来的事件也走这里
  );

  // ── 拖拽 / 单击 ──
  let downView: PetView | null = null;
  let downX = 0;
  let downY = 0;
  let dragView: PetView | null = null;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const v = views.find((vv) => vv.hitTestSprite(e.clientX, e.clientY));
    if (v) {
      downView = v;
      downX = e.clientX;
      downY = e.clientY;
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (downView && !dragView) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > downView.getDragThreshold()) {
        dragView = downView;
        dragView.beginDrag(downX, downY);
      }
    }
    dragView?.dragTo(e.clientX, e.clientY);
  });

  document.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    endPointer();
    if (downView) {
      const v = downView;
      downView = null;
      // 延迟 300ms 触发台词：若 300ms 内出现第二次点击（双击），
      // 由 dblclick 取消本次台词并进入聊天 —— 单击=爸爸，双击=对话
      const t = setTimeout(() => {
        pendingLineA.delete(v);
        void doLineA(v);
      }, 300);
      pendingLineA.set(v, t);
    }
  });

  /** 各角色待触发的台词计时器（双击时取消） */
  const pendingLineA = new Map<PetView, ReturnType<typeof setTimeout>>();

  /** 结束拖拽/按压（pointerup 丢失时由 pointercancel/blur 兜底） */
  function endPointer(): void {
    if (dragView) {
      dragView.endDrag(); // 按拖拽速度抛出
      dragView = null;
      downView = null;
    }
  }
  // 快速甩动时指针可能离开宠物像素导致 setIgnoreMouseEvents(true)，
  // pointerup 永远到不了 → 永久卡在拖拽态。这里双保险。
  document.addEventListener('pointercancel', endPointer);
  window.addEventListener('blur', endPointer);

  // ── RAF 主循环 ──
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(50, now - last); // 掉帧钳制，防大步长穿透
    last = now;
    const states = views.map((v) => v.pet);
    for (const v of views) {
      // 说话中：口型覆盖动作；说完定格闭嘴
      const talking = v.bubble.isTalking();
      const override = talking ? syncMouth(v.bubble.getDisplayedCount()) : undefined;
      v.frozen = v.bubble.isChatOpen(); // 聊天打开 → 待在原地
      v.update(dt, states, obstacles, bounds(), now, rng, override);
    }
    hoverCheck(now); // 宠物可能走到静止光标下
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 冒烟/调试钩子：供主进程 executeJavaScript 驱动（DECKPET_SMOKE 截图用）
  (window as unknown as Record<string, unknown>).__petDebug = {
    lineA: (charId: string) => {
      const v = byId.get(charId);
      if (v) void doLineA(v);
    },
    chat: (charId: string, text: string) => {
      const v = byId.get(charId);
      if (v) {
        v.bubble.enterChatMode();
        sendChat(v, text);
      }
    },
    openChat: (charId: string) => {
      const v = byId.get(charId);
      if (v) v.bubble.enterChatMode();
    },
    // 抛落测试：thrown=true 模拟纵向拖抛落地
    drop: (charId: string) => {
      const v = byId.get(charId);
      if (v) {
        Object.assign(v.pet, { y: 300, vy: 0, vx: 0, support: null, thrown: true, mode: 'crawl', modeElapsedMs: 0 });
      }
    },
    // 单杠测试：直接进入 bar_hang
    bar: (charId: string) => {
      const v = byId.get(charId);
      if (v) {
        // 居中+身体完整在屏幕内（y 为脚底锚点，需大于一个身位）
        Object.assign(v.pet, { x: Math.round(window.innerWidth / 2), y: 240, vy: 0, vx: 0, support: { type: 'top' }, mode: 'bar_hang', modeElapsedMs: 0 });
      }
    },
    // 当前帧调试信息
    state: (charId: string) => {
      const v = byId.get(charId);
      return v ? { mode: v.pet.mode, action: v.pet.action, frame: v.pet.frameIndex, y: v.pet.y } : null;
    },
    collab: (task: string) => {
      startCollab(task);
    },
  };

  // 循环提醒：气泡弹出 + 蹦跳动作
  api.onReminder((r) => {
    for (const v of views) {
      v.bubble.showLineA(`⏰【${r.category}】${r.title}`);
      v.triggerGesture('jump', performance.now());
    }
  });
}

void bootstrap();
