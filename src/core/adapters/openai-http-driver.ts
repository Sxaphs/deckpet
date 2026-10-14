import type {
  AgentDriver,
  AgentSessionHandle,
  BackendConfig,
  ChatChunk,
  ChatMessage,
  DriverContext,
  PromptOptions,
} from '../types.js';

/**
 * OpenAI 兼容 HTTP driver：直连 `${baseUrl}/chat/completions`（stream: true），
 * 解析 SSE（`data: ` 行，`[DONE]` 结束），delta 取 choices[0].delta.content。
 *
 * 适用于 DeepSeek / Moonshot / OpenAI / vLLM 等一切 OpenAI 兼容端点。
 * 密钥经 DriverContext.resolveSecret(apiKeyRef) 在内存中解密，不落盘；
 * 无 key 且无 apiKeyRef 时不带 Authorization 头（本地服务场景）。
 *
 * 权限兜底：每次发起请求前过 PolicyEngine.authorize({kind:'net.fetch'})，
 * 拒绝即报错，绝不绕过权限层。
 */

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

export function createOpenAiHttpDriver(
  backend: BackendConfig,
  ctx: DriverContext,
): AgentDriver {
  const baseUrl = (backend.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = backend.model ?? 'gpt-4o-mini';
  const completionsUrl = `${baseUrl}/chat/completions`;

  async function buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (backend.apiKeyRef) {
      const key = await ctx.resolveSecret(backend.apiKeyRef);
      if (!key) {
        throw new Error(`apiKeyRef "${backend.apiKeyRef}" 无法从密钥库解析`);
      }
      headers.Authorization = `Bearer ${key}`;
    }
    return headers;
  }

  async function authorizeNet(url: string): Promise<void> {
    const d = await ctx.policy.authorize({
      kind: 'net.fetch',
      url,
      reason: `openai-http 请求 ${backend.name ?? backend.id}`,
      origin: 'openai-http',
    });
    if (!d.allow) throw new Error(`权限层拒绝联网请求: ${d.reason}`);
  }

  /** 一次流式 chat completion，产出 ChatChunk */
  async function* streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    await authorizeNet(completionsUrl);
    const headers = await buildHeaders();
    const res = await fetch(completionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(data) as ChatCompletionChunk;
          } catch {
            continue; // 心跳/注释等无法解析的 data 行
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            yield { type: 'delta', text: delta };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { type: 'done' };
  }

  class OpenAiSession implements AgentSessionHandle {
    readonly id = `openai-http-${Math.random().toString(36).slice(2, 10)}`;
    /** 会话内消息数组：systemPrompt 固定占 messages[0]，之后 user/assistant 交替追加 */
    private messages: ChatMessage[] = [];
    private controller: AbortController | null = null;

    constructor(systemPrompt?: string) {
      if (systemPrompt) {
        this.messages.push({ role: 'system', content: systemPrompt });
      }
    }

    async *prompt(text: string, opts?: PromptOptions): AsyncIterable<ChatChunk> {
      this.messages.push({ role: 'user', content: text });
      const controller = new AbortController();
      this.controller = controller;
      const onOuterAbort = () => controller.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      let reply = '';
      try {
        for await (const chunk of streamChat(this.messages, controller.signal)) {
          if (chunk.type === 'delta') reply += chunk.text;
          yield chunk;
          if (chunk.type === 'done') break;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          yield { type: 'status', text: '已中断' };
        } else {
          yield { type: 'error', error: String(err) };
        }
        yield { type: 'done' };
      } finally {
        opts?.signal?.removeEventListener('abort', onOuterAbort);
        this.controller = null;
      }
      // 只保留完整成文的回复进上下文，被中断/出错的半成品不回填
      if (reply) this.messages.push({ role: 'assistant', content: reply });
    }

    async cancel(): Promise<void> {
      this.controller?.abort();
    }

    async dispose(): Promise<void> {
      this.controller?.abort();
    }
  }

  return {
    type: 'openai-http',
    supportsSystemPrompt: true,

    async test() {
      // 探测 GET /models（本地服务一般也实现该端点）
      const modelsUrl = `${baseUrl}/models`;
      try {
        await authorizeNet(modelsUrl);
        const headers = await buildHeaders();
        const res = await fetch(modelsUrl, { headers });
        if (!res.ok) {
          return { ok: false, detail: `GET /models -> HTTP ${res.status}` };
        }
        return { ok: true, detail: `GET /models ok (model=${model})` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },

    async createSession(opts) {
      return new OpenAiSession(opts.systemPrompt);
    },
  };
}
