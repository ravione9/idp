import logger from '../../utils/logger.js';
import { loadAttendanceIgaConfig, pollingIntervalMs, scheduledPipelineSource } from './config.js';
import { runAttendanceIgaPipeline } from './orchestrator.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startAttendanceIgaScheduler(): void {
  void scheduleNext();
}

async function scheduleNext(): Promise<void> {
  try {
    const config = await loadAttendanceIgaConfig();
    if (config.enabled !== 1) {
      logger.info('Attendance IGA scheduler disabled');
      return;
    }
    const ms = pollingIntervalMs(config.polling_interval);
    if (!ms) {
      logger.info('Attendance IGA polling set to manual — scheduler idle');
      return;
    }

    if (timer) clearInterval(timer);
    timer = setInterval(() => { void tick(); }, ms);
    logger.info({ intervalMs: ms }, 'Attendance IGA scheduler started');
  } catch (err) {
    logger.error({ err }, 'Attendance IGA scheduler init failed');
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = await loadAttendanceIgaConfig();
    if (config.enabled !== 1) return;

    const source = scheduledPipelineSource(config.source_type);
    if (!source) return;

    await runAttendanceIgaPipeline({
      source,
      initiatedBy: 'attendance-scheduler',
    });
  } catch (err) {
    logger.error({ err }, 'Attendance IGA scheduled run failed');
  } finally {
    running = false;
  }
}

export function stopAttendanceIgaScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
