import type { BackendConfig, DriverContext, DriverFactory, AgentDriver } from '../types.js';

/**
 * Driver 插件注册表。新增后端 = 实现 DriverFactory 后 register 一次，
 * 核心代码零改动（详见 docs/adapter-api.md）。
 */
const factories = new Map<string, DriverFactory>();

export function registerDriver(type: string, factory: DriverFactory): void {
  if (factories.has(type)) throw new Error(`driver type 重复注册: ${type}`);
  factories.set(type, factory);
}

export function hasDriver(type: string): boolean {
  return factories.has(type);
}

export function createDriver(
  backend: BackendConfig,
  ctx: DriverContext,
): AgentDriver {
  const f = factories.get(backend.type);
  if (!f) {
    throw new Error(
      `未注册的 driver 类型 "${backend.type}"（backend id=${backend.id}）。` +
        `已注册: ${[...factories.keys()].join(', ') || '(空)'}`,
    );
  }
  return f(backend, ctx);
}
