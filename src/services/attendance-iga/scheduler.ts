import logger from '../../utils/logger.js';
import { withSchedLock } from '../../utils/sched-lock.js';
import {
  listAttendanceIgaConfigs,
  configIsDue,
  scheduledPipelineSource,
} from './config.js';
import { runAttendanceIgaPipeline } from './orchestrator.js';

let timer: ReturnType<typeof setInterval> | null = null;
const runningByConfig = new Set<number>();

/** Single 60s tick — each enabled config runs when its own interval is due. */
export function startAttendanceIgaScheduler(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void withSchedLock('attendance-iga', 55_000, tickAll);
  }, 60_000);
  logger.info('Attendance IGA multi-config scheduler started (60s tick)');
  void withSchedLock('attendance-iga', 55_000, tickAll);
}

async function tickAll(): Promise<void> {
  try {
    const configs = await listAttendanceIgaConfigs();
    const due = configs.filter((c) => configIsDue(c));
    for (const config of due) {
      if (runningByConfig.has(config.id)) continue;
      const source = scheduledPipelineSource(config.source_type);
      if (!source) continue;

      runningByConfig.add(config.id);
      try {
        logger.info({ configId: config.id, name: config.name, source }, 'Attendance IGA scheduled run');
        await runAttendanceIgaPipeline({
          source,
          initiatedBy: 'attendance-scheduler',
          configId: config.id,
        });
      } catch (err) {
        logger.error({ err, configId: config.id }, 'Attendance IGA scheduled run failed');
      } finally {
        runningByConfig.delete(config.id);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Attendance IGA scheduler tick failed');
  }
}

export function stopAttendanceIgaScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
