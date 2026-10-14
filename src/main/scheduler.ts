/**
 * 循环提醒调度器：每 30s 检查一次 settings.reminders，
 * 到点（HH:MM 匹配当天未触发）且任务启用、分类未被关闭 → 推送给桌宠气泡。
 * 触发记录只在内存里（每次运行每天最多触发一次，重启应用当天可再触发一次，可接受）。
 */
import type { WebContents } from 'electron';
import type { SettingsStore } from '../core/config/settings.js';
import { CH } from '../core/ipc-contract.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export function startScheduler(
  store: SettingsStore,
  getPetContents: () => WebContents | null,
  logger: Logger,
): () => void {
  const firedToday = new Map<string, string>(); // taskId → 'YYYY-MM-DD'

  const timer = setInterval(() => {
    const s = store.load();
    if (!s.reminders.length) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);

    for (const t of s.reminders) {
      if (!t.enabled) continue;
      if (s.disabledReminderCategories.includes(t.category)) continue;
      if (t.time !== hhmm) continue;
      if (firedToday.get(t.id) === today) continue;
      firedToday.set(t.id, today);

      const wc = getPetContents();
      if (wc && !wc.isDestroyed()) {
        try {
          wc.send(CH.reminder, { title: t.title, category: t.category });
          logger('info', `提醒触发: ${t.title}`);
        } catch {
          /* 窗口销毁中 */
        }
      }
    }
  }, 30_000);

  return () => clearInterval(timer);
}
