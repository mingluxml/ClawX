/**
 * Skill Importer
 * Imports skills from Git repository URLs
 * Supports both full repo URLs and subdirectory URLs (e.g., /tree/main/path/to/skill)
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { getCoPawCustomizedSkillsDir } from './copaw-paths';
import { logger } from './logger';

const ALLOWED_HOSTS = ['github.com', 'gitlab.com', 'gitee.com'];
const CLONE_TIMEOUT_MS = 60_000;

export interface ImportResult {
  success: boolean;
  skillName?: string;
  skillPath?: string;
  error?: string;
  errorCode?: 'INVALID_URL' | 'NOT_ALLOWED' | 'ALREADY_EXISTS' | 'GIT_NOT_FOUND' | 'CLONE_FAILED' | 'TIMEOUT';
}

interface ParsedGitUrl {
  repoUrl: string;   // https://github.com/owner/repo.git
  branch?: string;    // e.g., "main"
  subPath?: string;   // e.g., "skills/skill-creator"
  skillName: string;  // last segment, e.g., "skill-creator" or repo name
}

/**
 * Parse a Git URL, supporting both root repos and subdirectory URLs.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/branch/path/to/subdir
 *   https://gitlab.com/owner/repo/-/tree/branch/path/to/subdir
 *   https://gitee.com/owner/repo/tree/branch/path/to/subdir
 */
function parseGitUrl(url: string): ParsedGitUrl | null {
  // GitHub / Gitee subdirectory: /owner/repo/tree/branch/path...
  const ghSubdirMatch = url.match(
    /^https:\/\/(github\.com|gitee\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/tree\/([\w.\-/]+)$/
  );
  if (ghSubdirMatch) {
    const [, host, owner, repo, rest] = ghSubdirMatch;
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      // Just a branch, no subdir (e.g., /tree/main) – treat as root repo
      return {
        repoUrl: `https://${host}/${owner}/${repo}.git`,
        branch: rest,
        skillName: repo,
      };
    }
    const branch = rest.slice(0, slashIdx);
    const subPath = rest.slice(slashIdx + 1);
    return {
      repoUrl: `https://${host}/${owner}/${repo}.git`,
      branch,
      subPath,
      skillName: basename(subPath),
    };
  }

  // GitLab subdirectory: /owner/repo/-/tree/branch/path...
  const glSubdirMatch = url.match(
    /^https:\/\/(gitlab\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/-\/tree\/([\w.\-/]+)$/
  );
  if (glSubdirMatch) {
    const [, host, owner, repo, rest] = glSubdirMatch;
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return {
        repoUrl: `https://${host}/${owner}/${repo}.git`,
        branch: rest,
        skillName: repo,
      };
    }
    const branch = rest.slice(0, slashIdx);
    const subPath = rest.slice(slashIdx + 1);
    return {
      repoUrl: `https://${host}/${owner}/${repo}.git`,
      branch,
      subPath,
      skillName: basename(subPath),
    };
  }

  // Plain repo URL: /owner/repo or /owner/repo.git
  const repoMatch = url.match(
    /^https:\/\/(github\.com|gitlab\.com|gitee\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
  );
  if (repoMatch) {
    const [, host, owner, repo] = repoMatch;
    return {
      repoUrl: `https://${host}/${owner}/${repo}.git`,
      skillName: repo,
    };
  }

  return null;
}

/**
 * Validate a Git URL against the whitelist
 */
export function validateGitUrl(url: string): { valid: boolean; error?: string; errorCode?: string; parsed?: ParsedGitUrl } {
  const trimmed = url.trim();

  if (!trimmed) {
    return { valid: false, error: 'URL is empty', errorCode: 'INVALID_URL' };
  }

  // Try to parse as URL first
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format', errorCode: 'INVALID_URL' };
  }

  // Check protocol
  if (parsedUrl.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS URLs are supported', errorCode: 'INVALID_URL' };
  }

  // Check host against whitelist
  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    return {
      valid: false,
      error: `Domain "${parsedUrl.hostname}" is not allowed. Supported: ${ALLOWED_HOSTS.join(', ')}`,
      errorCode: 'NOT_ALLOWED',
    };
  }

  // Parse the Git URL structure
  const parsed = parseGitUrl(trimmed);
  if (!parsed) {
    return { valid: false, error: 'Invalid repository URL format', errorCode: 'INVALID_URL' };
  }

  return { valid: true, parsed };
}

/**
 * Check if git is available on the system
 */
function checkGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['--version'], { stdio: 'pipe', timeout: 5000 });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Import a skill from a Git repository URL
 */
export async function importSkillFromUrl(url: string): Promise<ImportResult> {
  const trimmedUrl = url.trim();

  // 1. Validate URL
  const validation = validateGitUrl(trimmedUrl);
  if (!validation.valid || !validation.parsed) {
    return {
      success: false,
      error: validation.error,
      errorCode: validation.errorCode as ImportResult['errorCode'],
    };
  }

  const { repoUrl, branch, subPath, skillName } = validation.parsed;

  // 2. Check git is available
  const gitAvailable = await checkGitAvailable();
  if (!gitAvailable) {
    return {
      success: false,
      error: 'Git is not installed or not found in PATH',
      errorCode: 'GIT_NOT_FOUND',
    };
  }

  // 3. Determine target directory
  const skillsDir = getCoPawCustomizedSkillsDir();
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  const targetDir = join(skillsDir, skillName);

  // 4. Check if skill already exists
  if (existsSync(targetDir)) {
    return {
      success: false,
      skillName,
      error: `Skill "${skillName}" already exists`,
      errorCode: 'ALREADY_EXISTS',
    };
  }

  // 5. Clone the repository
  logger.info(`[skill-importer] Cloning ${repoUrl} (branch: ${branch || 'default'}, subPath: ${subPath || 'root'})`);

  if (subPath) {
    // Subdirectory import: clone to temp dir, then copy the subdir
    const tempDir = join(tmpdir(), `clawx-skill-import-${Date.now()}`);
    try {
      await gitClone(repoUrl, tempDir, branch);

      // Verify the subdirectory exists
      const sourceDir = join(tempDir, subPath);
      if (!existsSync(sourceDir)) {
        throw new Error(`Subdirectory "${subPath}" not found in repository`);
      }

      // Copy subdirectory to skills dir
      cpSync(sourceDir, targetDir, { recursive: true });

      logger.info(`[skill-importer] Extracted subdirectory "${subPath}" to ${targetDir}`);
    } catch (error) {
      // Clean up target if partially copied
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      let errorCode: ImportResult['errorCode'] = 'CLONE_FAILED';
      if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
        errorCode = 'TIMEOUT';
      }

      logger.error(`[skill-importer] Subdirectory import failed: ${errorMsg}`);
      return {
        success: false,
        skillName,
        error: errorMsg,
        errorCode,
      };
    } finally {
      // Clean up temp clone
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } else {
    // Full repo import: clone directly to skills dir
    try {
      await gitClone(repoUrl, targetDir, branch);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      let errorCode: ImportResult['errorCode'] = 'CLONE_FAILED';
      if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
        errorCode = 'TIMEOUT';
      }

      logger.error(`[skill-importer] Clone failed: ${errorMsg}`);
      return {
        success: false,
        skillName,
        error: errorMsg,
        errorCode,
      };
    }
  }

  logger.info(`[skill-importer] Successfully imported skill "${skillName}"`);

  return {
    success: true,
    skillName,
    skillPath: targetDir,
  };
}

/**
 * Run git clone as a child process
 */
function gitClone(url: string, targetDir: string, branch?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push(url, targetDir);

    const proc = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLONE_TIMEOUT_MS,
    });

    let stderr = '';

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git clone exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (err.message.includes('ETIMEDOUT') || err.message.includes('killed')) {
        reject(new Error('Clone operation timed out'));
      } else {
        reject(err);
      }
    });
  });
}
