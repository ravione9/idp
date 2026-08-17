const mockRunMigrations = jest.fn().mockResolvedValue(undefined);
const mockRepairSchemaDrift = jest.fn().mockResolvedValue(undefined);

jest.mock('./migrate', () => ({
  runMigrations: (...args: unknown[]) => mockRunMigrations(...args),
}));

jest.mock('./schema-repair', () => ({
  repairSchemaDrift: (...args: unknown[]) => mockRepairSchemaDrift(...args),
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

import { maybeRunBootMigrations } from './migrate-boot';
import logger from '../utils/logger';

describe('SKIP_MIGRATIONS_ON_BOOT gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips runMigrations when skipMigrationsOnBoot is true', async () => {
    await maybeRunBootMigrations(true);
    expect(mockRunMigrations).not.toHaveBeenCalled();
    expect(mockRepairSchemaDrift).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'SKIP_MIGRATIONS_ON_BOOT=true — migrations handled externally (K8s Job)',
    );
  });

  it('runs runMigrations when skipMigrationsOnBoot is false', async () => {
    await maybeRunBootMigrations(false);
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(mockRepairSchemaDrift).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Running database migrations on boot (skipping already-applied)',
    );
  });
});
