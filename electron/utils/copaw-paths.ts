/**
 * CoPaw Path Utilities
 * Path resolution helpers for CoPaw backend
 */
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { logger } from './logger';

/**
 * Get CoPaw home directory
 */
export function getCoPawHomeDir(): string {
  return process.env.COPAW_HOME || join(homedir(), '.copaw');
}

/**
 * Get CoPaw virtual environment directory
 */
export function getCoPawVenvDir(): string {
  return join(getCoPawHomeDir(), 'venv');
}

/**
 * Get CoPaw config file path
 */
export function getCoPawConfigPath(): string {
  return join(getCoPawHomeDir(), 'config.json');
}

/**
 * Get CoPaw working directory
 */
export function getCoPawWorkingDir(): string {
  return join(getCoPawHomeDir(), 'working_dir');
}

/**
 * Get CoPaw skills directory (working_dir/skills)
 */
export function getCoPawSkillsDir(): string {
  return join(getCoPawWorkingDir(), 'skills');
}

/**
 * Get CoPaw customized skills directory (~/.copaw/customized_skills)
 * This is where user-imported skills are stored and discovered by CoPaw.
 */
export function getCoPawCustomizedSkillsDir(): string {
  return join(getCoPawHomeDir(), 'customized_skills');
}

/**
 * Get CoPaw binary path (platform-specific)
 */
export function getCoPawBinPath(): string {
  const venvDir = getCoPawVenvDir();
  if (process.platform === 'win32') {
    return join(venvDir, 'Scripts', 'copaw.exe');
  }
  return join(venvDir, 'bin', 'copaw');
}

/**
 * Get Python path in CoPaw venv
 */
export function getCoPawPythonPath(): string {
  const venvDir = getCoPawVenvDir();
  if (process.platform === 'win32') {
    return join(venvDir, 'Scripts', 'python.exe');
  }
  return join(venvDir, 'bin', 'python');
}

/**
 * Get pip path in CoPaw venv
 */
export function getCoPawPipPath(): string {
  const venvDir = getCoPawVenvDir();
  if (process.platform === 'win32') {
    return join(venvDir, 'Scripts', 'pip.exe');
  }
  return join(venvDir, 'bin', 'pip');
}

/**
 * Check if CoPaw is installed
 */
export function isCoPawInstalled(): boolean {
  const binPath = getCoPawBinPath();
  const venvDir = getCoPawVenvDir();
  return existsSync(binPath) && existsSync(venvDir);
}

/**
 * Get CoPaw version from installed package
 */
export async function getCoPawVersion(): Promise<string | undefined> {
  if (!isCoPawInstalled()) {
    return undefined;
  }

  try {
    const pipPath = getCoPawPipPath();
    if (!existsSync(pipPath)) {
      return undefined;
    }

    const { execSync } = await import('child_process');
    const output = execSync(`"${pipPath}" show copaw`, { 
      encoding: 'utf-8',
      timeout: 10000 
    });
    
    const versionMatch = output.match(/^Version:\s*(.+)$/m);
    return versionMatch?.[1]?.trim();
  } catch (err) {
    logger.debug('Failed to get CoPaw version:', err);
    return undefined;
  }
}

/**
 * CoPaw status for environment check
 */
export interface CoPawStatus {
  installed: boolean;
  venvExists: boolean;
  binPath: string;
  homeDir: string;
  version?: string;
}

export async function getCoPawStatus(): Promise<CoPawStatus> {
  const homeDir = getCoPawHomeDir();
  const venvDir = getCoPawVenvDir();
  const binPath = getCoPawBinPath();
  const installed = isCoPawInstalled();
  
  let version: string | undefined;
  if (installed) {
    version = await getCoPawVersion();
  }

  const status: CoPawStatus = {
    installed,
    venvExists: existsSync(venvDir),
    binPath,
    homeDir,
    version,
  };

  logger.info('CoPaw status:', status);
  return status;
}

/**
 * Get bundled uv binary path
 */
export function getUvBinPath(): string {
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binName = platform === 'win32' ? 'uv.exe' : 'uv';
  
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', binName);
  } else {
    return join(process.cwd(), 'resources', 'bin', target, binName);
  }
}

/**
 * Check if uv binary exists
 */
export function isUvAvailable(): boolean {
  const uvPath = getUvBinPath();
  return existsSync(uvPath);
}
