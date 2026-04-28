import { checkAll } from '@/lib/healthcheck.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { healthRepo } from '@/db/repositories.js';

const downSinceByComponent = new Map<string, Date>();
const ALERTED = new Map<string, boolean>();
const DOWN_THRESHOLD_MS = 2 * 60 * 1000;
const DEGRADED_THRESHOLD_MS = 10 * 60 * 1000;

export async function runHealthMonitor(): Promise<void> {
  const report = await checkAll();
  for (const c of report.components) {
    if (c.status === 'ok') {
      const wasDown = downSinceByComponent.has(c.component);
      if (wasDown) {
        downSinceByComponent.delete(c.component);
        if (ALERTED.get(c.component)) {
          ALERTED.set(c.component, false);
          await sendAlert({
            subject: `${c.component} recovered`,
            body: `Componente ${c.component} voltou ao normal.`,
          });
        }
      }
      continue;
    }
    const since = downSinceByComponent.get(c.component) ?? new Date();
    if (!downSinceByComponent.has(c.component)) downSinceByComponent.set(c.component, since);
    const elapsed = Date.now() - since.getTime();
    const threshold = c.status === 'down' ? DOWN_THRESHOLD_MS : DEGRADED_THRESHOLD_MS;
    if (elapsed >= threshold && !ALERTED.get(c.component)) {
      ALERTED.set(c.component, true);
      await sendAlert({
        subject: `${c.component} ${c.status} for ${Math.floor(elapsed / 60000)}min`,
        body: `Componente ${c.component} está ${c.status} há ${Math.floor(elapsed / 60000)} minutos. Detalhes: ${JSON.stringify(c.details ?? {})}`,
      });
      logger.warn({ component: c.component, elapsed_ms: elapsed }, 'health.alert_fired');
      await healthRepo.record({
        component: c.component,
        status: c.status,
        metadata: { alert_fired: true, elapsed_ms: elapsed },
      });
    }
  }
}
