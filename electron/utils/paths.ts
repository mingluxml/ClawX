/**
 * Path Utilities
 * Cross-platform path resolution helpers
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { logger } from './logger';

// ESM compatibility: define __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export { quoteForCmd, needsWinShell, prepareWinSpawn } from './win-shell';

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return path.replace('~', homedir());
  }
  return path;
}

/**
 * Get CoPaw config directory
 * @deprecated Use getCoPawHomeDir from copaw-paths.ts instead
 */
export function getOpenClawConfigDir(): string {
  return join(homedir(), '.copaw');
}

/**
 * Get CoPaw skills directory
 * @deprecated Use getCoPawSkillsDir from copaw-paths.ts instead
 */
export function getOpenClawSkillsDir(): string {
  return join(getOpenClawConfigDir(), 'skills');
}

/**
 * Get ClawX config directory
 */
export function getClawXConfigDir(): string {
  return join(homedir(), '.clawx');
}

/**
 * Get ClawX logs directory
 */
export function getLogsDir(): string {
  return join(app.getPath('userData'), 'logs');
}

/**
 * Get ClawX data directory
 */
export function getDataDir(): string {
  return app.getPath('userData');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get resources directory (for bundled assets)
 */
export function getResourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(__dirname, '../../resources');
}

/**
 * Get preload script path
 */
export function getPreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/**
 * Get CoPaw package directory
 * For CoPaw, this returns the venv directory since CoPaw is installed via uv
 * @deprecated Use getCoPawVenvDir from copaw-paths.ts instead
 */
export function getOpenClawDir(): string {
  return join(homedir(), '.copaw', 'venv');
}

/**
 * Get CoPaw package directory resolved to a real path.
 * @deprecated Use copaw-paths.ts functions instead
 */
export function getOpenClawResolvedDir(): string {
  const dir = getOpenClawDir();
  if (!existsSync(dir)) {
    return dir;
  }
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Get CoPaw entry script path
 * @deprecated CoPaw is launched via uv run copaw
 */
export function getOpenClawEntryPath(): string {
  const binName = process.platform === 'win32' ? 'copaw.exe' : 'copaw';
  return join(getOpenClawDir(), process.platform === 'win32' ? 'Scripts' : 'bin', binName);
}

/**
 * Check if CoPaw is installed
 * @deprecated Use isCoPawInstalled from copaw-paths.ts instead
 */
export function isOpenClawPresent(): boolean {
  const venvDir = getOpenClawDir();
  const binPath = getOpenClawEntryPath();
  return existsSync(venvDir) && existsSync(binPath);
}

/**
 * Check if CoPaw is ready (venv exists and binary available)
 * @deprecated Use isCoPawInstalled from copaw-paths.ts instead
 */
export function isOpenClawBuilt(): boolean {
  return isOpenClawPresent();
}

/**
 * Get CoPaw status for environment check
 * @deprecated Use getCoPawStatus from copaw-paths.ts instead
 */
export interface OpenClawStatus {
  packageExists: boolean;
  isBuilt: boolean;
  entryPath: string;
  dir: string;
  version?: string;
}

export function getOpenClawStatus(): OpenClawStatus {
  const dir = getOpenClawDir();

  const status: OpenClawStatus = {
    packageExists: isOpenClawPresent(),
    isBuilt: isOpenClawBuilt(),
    entryPath: getOpenClawEntryPath(),
    dir,
    version: undefined, // Version detection requires running copaw --version
  };

  logger.info('CoPaw status:', status);
  return status;
}
