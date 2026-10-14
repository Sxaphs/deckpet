import { hasDriver, registerDriver } from './registry.js';
import { createAcpDriver } from './acp-driver.js';
import { createOpenAiHttpDriver } from './openai-http-driver.js';
import { createDshDriver } from './dsh-driver.js';

/**
 * 注册内置 driver（acp / openai-http / dsh）。幂等：重复调用不会重复注册，
 * 便于 CLI、Electron 主进程、测试各自独立调用。
 */
export function registerBuiltinDrivers(): void {
  if (!hasDriver('acp')) registerDriver('acp', createAcpDriver);
  if (!hasDriver('openai-http')) registerDriver('openai-http', createOpenAiHttpDriver);
  if (!hasDriver('dsh')) registerDriver('dsh', createDshDriver);
}
