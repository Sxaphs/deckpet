/**
 * 气泡：流式输出、折叠展开、聊天输入、自动淡出、口型节奏。
 * DOM 绝对定位在 document.body，方向（上/下/左/右）按角色象限自动选择并 clamp 在屏幕内；
 * 尾巴（::after 三角）通过 dp-place-* class 切换，锚定角色嘴边。
 */
import type { SpriteAction } from '../../core/sprite-contract.js';

const IDLE_FADE_MS = 6000; // 空闲 6 秒淡出
const CHAT_IDLE_MS = 10000; // 聊天模式 10 秒无输入自动关闭
const TYPE_MS_PER_CHAR = 40; // 台词 A 打字机速度
const MOUTH_CHARS_PER_FRAME = 3; // 每 ~3 字换一次口型

/**
 * 口型节奏：按已显示字符数循环 开/半/闭。
 * 调用方在说话结束时直接定格 talk_closed。
 */
export function syncMouth(displayedCharCount: number): SpriteAction {
  const phase = Math.floor(displayedCharCount / MOUTH_CHARS_PER_FRAME) % 3;
  return phase === 0 ? 'talk_open' : phase === 1 ? 'talk_half' : 'talk_closed';
}

type Place = 'top' | 'bottom' | 'left' | 'right';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Bubble {
  readonly el: HTMLDivElement;
  private content: HTMLDivElement;
  private inputRow: HTMLDivElement;
  private input: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;

  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private chatIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private closeBtn: HTMLButtonElement;
  private devBtn: HTMLButtonElement; // 开发者模式开关（显示过程事件）
  private typeTimer: ReturnType<typeof setInterval> | null = null;
  private typeQueue = '';
  private streaming = false;
  private typing = false;
  private chatMode = false;
  private visible = false;
  /** 开发者模式：true 时气泡里显示 status/工具调用等过程事件 */
  devMode = false;
  /** 已显示字符数（驱动口型；折叠时只按 summary 长度计） */
  private displayed = 0;

  // 由外部（main.ts）赋值的回调
  onSend: (text: string) => void = () => {};
  onStop: () => void = () => {};
  onExpand: (fullText: string, title: string) => void = () => {};
  /** 聊天开/关时通知外部（用来切换窗口可聚焦性） */
  onChatToggle: (open: boolean) => void = () => {};

  constructor(
    private charId: string,
    private charName: string,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'dp-bubble dp-place-top';

    this.content = document.createElement('div');
    this.content.className = 'dp-bubble-content';
    this.el.appendChild(this.content);

    // 聊天输入行：输入框 + 发送 + 停止（输出期才显示停止）
    this.inputRow = document.createElement('div');
    this.inputRow.className = 'dp-bubble-inputrow';
    this.input = document.createElement('input');
    this.input.className = 'dp-bubble-input';
    this.input.placeholder = `和${charName}说点什么…`;
    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'dp-btn';
    this.sendBtn.textContent = '发送';
    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'dp-btn dp-btn-stop';
    this.stopBtn.textContent = '停止';
    this.stopBtn.style.display = 'none';
    this.inputRow.append(this.input, this.sendBtn, this.stopBtn);
    this.inputRow.style.display = 'none';
    this.el.appendChild(this.inputRow);

    // 聊天模式的手动关闭按钮（右上角 ×）
    this.closeBtn = document.createElement('button');
    this.closeBtn.className = 'dp-bubble-close';
    this.closeBtn.textContent = '×';
    this.closeBtn.title = '关闭对话';
    this.closeBtn.style.display = 'none';
    this.closeBtn.addEventListener('click', () => this.exitChatMode());
    this.el.appendChild(this.closeBtn);

    // 开发者模式切换（chat 模式只看结果；dev 模式显示过程事件）
    this.devBtn = document.createElement('button');
    this.devBtn.className = 'dp-bubble-dev';
    this.devBtn.textContent = 'DEV';
    this.devBtn.title = '开发者模式：显示工具调用等过程事件';
    this.devBtn.style.display = 'none';
    this.devBtn.addEventListener('click', () => {
      this.devMode = !this.devMode;
      this.devBtn.classList.toggle('on', this.devMode);
    });
    this.el.appendChild(this.devBtn);

    const send = () => {
      const t = this.input.value.trim();
      if (!t) return;
      this.input.value = '';
      this.resetChatIdleTimer();
      this.onSend(t);
    };
    this.sendBtn.addEventListener('click', send);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
      e.stopPropagation();
      this.resetChatIdleTimer(); // 有输入活动，重置自动关闭
    });
    this.input.addEventListener('input', () => this.resetChatIdleTimer());
    this.input.addEventListener('focus', () => this.resetChatIdleTimer());
    this.stopBtn.addEventListener('click', () => this.onStop());
    // 鼠标悬停时重置淡出计时
    this.el.addEventListener('pointerenter', () => {
      if (this.visible) this.resetFadeTimer();
    });
  }

  isVisible(): boolean {
    return this.visible;
  }

  isTalking(): boolean {
    return this.streaming || this.typing;
  }

  getDisplayedCount(): number {
    return this.displayed;
  }

  private show(): void {
    this.visible = true;
    this.el.style.opacity = '1';
    this.resetFadeTimer();
  }

  private resetFadeTimer(): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      // 聊天模式 / 流式进行中不自动淡出
      if (this.chatMode || this.streaming) return;
      this.el.style.opacity = '0';
      this.visible = false;
    }, IDLE_FADE_MS);
  }

  private scrollBottom(): void {
    this.content.scrollTop = this.content.scrollHeight;
  }

  /** 流式开始：清空气泡 */
  beginStream(): void {
    this.streaming = true;
    this.displayed = 0;
    this.content.textContent = '';
    this.show();
  }

  /** 追加 token，自动滚到底 */
  appendToken(text: string): void {
    if (!this.streaming) this.beginStream();
    this.content.append(text);
    this.displayed += text.length;
    this.scrollBottom();
    this.resetFadeTimer();
  }

  /** 过程事件（仅开发者模式渲染，灰色小字） */
  showStatus(text: string): void {
    const div = document.createElement('div');
    div.className = 'dp-status';
    div.textContent = `⚙ ${text}`;
    this.content.appendChild(div);
    this.scrollBottom();
    this.resetFadeTimer();
  }

  /**
   * speaker-end：folded 时内容替换为 summary + 「展开全部」按钮，
   * 口型只按 summary 长度走。
   */
  endStream(fullText: string, summary: string, folded: boolean): void {
    this.streaming = false;
    if (folded) {
      this.content.textContent = '';
      this.content.append(summary);
      const btn = document.createElement('button');
      btn.className = 'dp-btn dp-expand';
      btn.textContent = '展开全部';
      btn.addEventListener('click', () => this.onExpand(fullText, `${this.charName} 的回复`));
      this.content.appendChild(document.createElement('br'));
      this.content.appendChild(btn);
      this.displayed = summary.length;
    }
    this.scrollBottom();
    this.resetFadeTimer();
    // 输出结束：重新起算 10 秒无输入自动关闭
    if (this.chatMode) this.resetChatIdleTimer();
  }

  /** 台词 A：一次性气泡，打字机式逐字显示（驱动口型） */
  showLineA(text: string): void {
    if (this.typeTimer) clearInterval(this.typeTimer);
    this.streaming = false;
    this.typing = true;
    this.typeQueue = text;
    this.displayed = 0;
    this.content.textContent = '';
    this.show();
    this.typeTimer = setInterval(() => {
      if (!this.typeQueue) {
        this.typing = false;
        if (this.typeTimer) clearInterval(this.typeTimer);
        this.typeTimer = null;
        this.resetFadeTimer();
        return;
      }
      const ch = this.typeQueue[0];
      this.typeQueue = this.typeQueue.slice(1);
      this.content.append(ch);
      this.displayed += 1;
      this.scrollBottom();
    }, TYPE_MS_PER_CHAR);
  }

  /** 聊天模式是否打开（main 用它冻结宠物移动） */
  isChatOpen(): boolean {
    return this.chatMode;
  }

  /** 进入聊天模式：显示输入框并聚焦；空气泡补占位文案；10 秒无输入自动关闭 */
  enterChatMode(): void {
    this.chatMode = true;
    this.inputRow.style.display = 'flex';
    this.closeBtn.style.display = '';
    this.devBtn.style.display = '';
    // 空内容时给占位文案，避免气泡缩成一个裸输入框
    if (!this.content.textContent?.trim()) {
      this.content.textContent = `嗨，我是${this.charName}，想聊点什么？`;
    }
    this.show();
    this.input.focus();
    this.resetChatIdleTimer();
    this.onChatToggle(true);
  }

  /** 退出聊天模式（手动 × / 自动关闭）：收起输入行并淡出 */
  exitChatMode(): void {
    this.chatMode = false;
    this.inputRow.style.display = 'none';
    this.closeBtn.style.display = 'none';
    this.devBtn.style.display = 'none';
    this.input.blur();
    if (this.chatIdleTimer) clearTimeout(this.chatIdleTimer);
    this.el.style.opacity = '0';
    this.visible = false;
    this.onChatToggle(false);
  }

  private resetChatIdleTimer(): void {
    if (!this.chatMode) return;
    if (this.chatIdleTimer) clearTimeout(this.chatIdleTimer);
    this.chatIdleTimer = setTimeout(() => {
      // 流式输出中不关；输入框已有半成品内容 → 一直等待手动关闭
      if (this.streaming) return;
      if (this.input.value.trim()) return;
      this.exitChatMode();
    }, CHAT_IDLE_MS);
  }

  /** 输出期切换：显示/隐藏停止按钮，禁用发送 */
  setOutputActive(active: boolean): void {
    this.stopBtn.style.display = active ? '' : 'none';
    this.sendBtn.disabled = active;
    this.input.disabled = active;
  }

  /** 工作区边界（由 main 每帧写入；气泡 clamp 不落到任务栏后） */
  boundsTop = 0;
  boundsBottom = Number.MAX_SAFE_INTEGER;
  boundsLeft = 0;
  boundsRight = Number.MAX_SAFE_INTEGER;

  /**
   * 每帧更新位置。
   * @param anchorX/anchorY 角色脚底中心；spriteW/H 当前帧尺寸；facing 朝向
   */
  update(anchorX: number, anchorY: number, spriteW: number, spriteH: number, facing: 1 | -1): void {
    if (!this.visible) return;
    const screenW = Math.min(window.innerWidth, this.boundsRight);
    const screenH = Math.min(window.innerHeight, this.boundsBottom);
    // 嘴边锚点：头侧偏上
    const mouthX = anchorX + facing * spriteW * 0.2;
    const mouthY = anchorY - spriteH * 0.75;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;

    // 象限选方向：优先上方，不够则下方，都不够放左右侧
    let place: Place;
    if (mouthY >= h + 30) place = 'top';
    else if (screenH - mouthY >= h + 30) place = 'bottom';
    else place = mouthX > screenW / 2 ? 'left' : 'right';

    let x: number;
    let y: number;
    switch (place) {
      case 'top':
        x = mouthX - 30;
        y = mouthY - h - 14;
        break;
      case 'bottom':
        x = mouthX - 30;
        y = mouthY + 14;
        break;
      case 'left':
        x = mouthX - w - 14;
        y = mouthY - h / 2;
        break;
      case 'right':
        x = mouthX + 14;
        y = mouthY - h / 2;
        break;
    }
    // clamp 在工作区内（不进任务栏、不出顶边）
    const pad = 8;
    x = clamp(x, this.boundsLeft + pad, Math.max(this.boundsLeft + pad, screenW - w - pad));
    y = clamp(y, this.boundsTop + pad, Math.max(this.boundsTop + pad, screenH - h - pad));

    this.el.classList.remove('dp-place-top', 'dp-place-bottom', 'dp-place-left', 'dp-place-right');
    this.el.classList.add(`dp-place-${place}`);
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }
}
