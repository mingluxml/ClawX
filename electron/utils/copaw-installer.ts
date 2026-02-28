/**
 * CoPaw Installer
 * Handles automatic installation of CoPaw backend using uv
 */
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { EventEmitter } from 'events';
import {
  getCoPawHomeDir,
  getCoPawVenvDir,
  getCoPawBinPath,
  getCoPawPythonPath,
  getUvBinPath,
  isUvAvailable,
  isCoPawInstalled,
} from './copaw-paths';
import { getUvMirrorEnv } from './uv-env';
import { logger } from './logger';
import { quoteForCmd, needsWinShell } from './paths';

/**
 * Installation progress event
 */
export interface InstallProgress {
  stage: 'preparing' | 'creating-venv' | 'installing-copaw' | 'initializing' | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  error?: string;
}

/**
 * Installation options
 */
export interface InstallOptions {
  version?: string; // specific version to install, e.g., "1.0.0"
  extras?: string[]; // optional extras, e.g., ["llamacpp", "mlx"]
  force?: boolean; // force reinstall even if already installed
  mirror?: boolean; // use PyPI mirror (default: auto-detect)
}

/**
 * CoPaw Installer
 */
export class CoPawInstaller extends EventEmitter {
  private installing = false;
  private currentProcess: ChildProcess | null = null;

  constructor() {
    super();
  }

  /**
   * Check if CoPaw needs to be installed
   */
  needsInstall(): boolean {
    return !isCoPawInstalled();
  }

  /**
   * Check if installation is in progress
   */
  isInstalling(): boolean {
    return this.installing;
  }

  /**
   * Install CoPaw
   */
  async install(options: InstallOptions = {}): Promise<void> {
    if (this.installing && !options.force) {
      throw new Error('Installation already in progress');
    }

    if (isCoPawInstalled() && !options.force) {
      logger.info('CoPaw is already installed, skipping installation');
      this.emitProgress('complete', 100, 'CoPaw is already installed');
      return;
    }

    this.installing = true;

    try {
      // Stage 1: Prepare environment
      this.emitProgress('preparing', 0, 'Preparing installation environment...');
      await this.prepareEnvironment();

      // Stage 2: Create virtual environment
      this.emitProgress('creating-venv', 20, 'Creating Python virtual environment...');
      await this.createVirtualEnvironment();

      // Stage 3: Install CoPaw package
      this.emitProgress('installing-copaw', 40, 'Installing CoPaw package...');
      await this.installCoPawPackage(options);

      // Stage 4: Initialize CoPaw
      this.emitProgress('initializing', 80, 'Initializing CoPaw...');
      await this.initializeCoPaw();

      // Complete
      this.emitProgress('complete', 100, 'CoPaw installation complete');
      logger.info('CoPaw installation completed successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('CoPaw installation failed:', error);
      this.emitProgress('error', 0, `Installation failed: ${errorMessage}`, errorMessage);
      throw error;
    } finally {
      this.installing = false;
      this.currentProcess = null;
    }
  }

  /**
   * Cancel ongoing installation
   */
  cancel(): void {
    if (this.currentProcess) {
      logger.info('Cancelling CoPaw installation...');
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
    this.installing = false;
  }

  /**
   * Prepare installation environment
   */
  private async prepareEnvironment(): Promise<void> {
    // Check uv availability
    if (!isUvAvailable()) {
      throw new Error('uv binary not found. Please ensure uv is bundled with the application.');
    }

    // Create CoPaw home directory
    const homeDir = getCoPawHomeDir();
    if (!existsSync(homeDir)) {
      logger.info(`Creating CoPaw home directory: ${homeDir}`);
      mkdirSync(homeDir, { recursive: true });
    }
  }

  /**
   * Create Python virtual environment using uv
   */
  private async createVirtualEnvironment(): Promise<void> {
    const uvBin = getUvBinPath();
    const venvDir = getCoPawVenvDir();

    // Skip if venv already exists
    if (existsSync(venvDir)) {
      logger.info(`Virtual environment already exists at: ${venvDir}`);
      return;
    }

    logger.info(`Creating virtual environment at: ${venvDir}`);
    
    const uvEnv = await getUvMirrorEnv();
    await this.runCommand(
      uvBin,
      ['venv', venvDir, '--python', '3.12'],
      'Create venv',
      uvEnv
    );

    logger.info('Virtual environment created successfully');
  }

  /**
   * Install CoPaw package using pip
   */
  private async installCoPawPackage(options: InstallOptions): Promise<void> {
    const pythonPath = getCoPawPythonPath();
    
    if (!existsSync(pythonPath)) {
      throw new Error(`Python not found at: ${pythonPath}`);
    }

    // Build pip install command
    let packageSpec = 'copaw';
    if (options.version) {
      packageSpec = `copaw==${options.version}`;
    }
    if (options.extras && options.extras.length > 0) {
      packageSpec = `copaw[${options.extras.join(',')}]`;
      if (options.version) {
        packageSpec = `copaw[${options.extras.join(',')}]==${options.version}`;
      }
    }

    logger.info(`Installing CoPaw package: ${packageSpec}`);

    const uvEnv = await getUvMirrorEnv();
    const pipEnv: Record<string, string> = {};
    
    // Use PyPI mirror if configured
    if (uvEnv.UV_INDEX_URL) {
      pipEnv.PIP_INDEX_URL = uvEnv.UV_INDEX_URL;
    }

    // Use uv pip for faster installation
    const uvBin = getUvBinPath();
    await this.runCommand(
      uvBin,
      ['pip', 'install', '--python', pythonPath, packageSpec],
      'Install CoPaw',
      { ...uvEnv, ...pipEnv }
    );

    // Verify installation
    const binPath = getCoPawBinPath();
    if (!existsSync(binPath)) {
      throw new Error(`CoPaw binary not found after installation at: ${binPath}`);
    }

    // Set executable permission on Unix
    if (process.platform !== 'win32') {
      try {
        chmodSync(binPath, 0o755);
      } catch (err) {
        logger.warn('Failed to set executable permission on CoPaw binary:', err);
      }
    }

    logger.info('CoPaw package installed successfully');
  }

  /**
   * Initialize CoPaw (create config, working directory, etc.)
   */
  private async initializeCoPaw(): Promise<void> {
    const binPath = getCoPawBinPath();
    
    if (!existsSync(binPath)) {
      throw new Error(`CoPaw binary not found at: ${binPath}`);
    }

    logger.info('Initializing CoPaw...');

    try {
      await this.runCommand(
        binPath,
        ['init', '--defaults', '--accept-security'],
        'Initialize CoPaw',
        {},
        30000 // 30 second timeout for init
      );
    } catch (err) {
      // Init might fail if already initialized, which is fine
      logger.warn('CoPaw init returned error (may already be initialized):', err);
    }

    logger.info('CoPaw initialization completed');
  }

  /**
   * Run a command with progress tracking
   */
  private async runCommand(
    command: string,
    args: string[],
    label: string,
    extraEnv: Record<string, string> = {},
    timeoutMs = 300000 // 5 minute default timeout
  ): Promise<string> {
    const useShell = needsWinShell(command);
    const spawnCmd = useShell ? quoteForCmd(command) : command;
    const spawnArgs = useShell ? args.map(a => quoteForCmd(a)) : args;

    return new Promise((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      logger.debug(`[${label}] Running: ${command} ${args.join(' ')}`);

      this.currentProcess = spawn(spawnCmd, spawnArgs, {
        shell: useShell,
        env: {
          ...process.env,
          ...extraEnv,
        },
      });

      const timeout = setTimeout(() => {
        if (this.currentProcess) {
          this.currentProcess.kill('SIGTERM');
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.currentProcess.stdout?.on('data', (data) => {
        const line = data.toString();
        stdoutChunks.push(line);
        logger.debug(`[${label}] stdout: ${line.trim()}`);
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const line = data.toString();
        stderrChunks.push(line);
        // Only log non-progress output as warnings
        const trimmed = line.trim();
        if (trimmed && !trimmed.includes('%') && !trimmed.includes('Downloading')) {
          logger.info(`[${label}] stderr: ${trimmed}`);
        }
      });

      this.currentProcess.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code === 0) {
          resolve(stdoutChunks.join(''));
        } else {
          const stderr = stderrChunks.join('');
          const stdout = stdoutChunks.join('');
          reject(new Error(
            `${label} failed with code ${code}\n` +
            `stderr: ${stderr}\n` +
            `stdout: ${stdout}`
          ));
        }
      });

      this.currentProcess.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`${label} spawn error: ${err.message}`));
      });
    });
  }

  /**
   * Emit progress event
   */
  private emitProgress(
    stage: InstallProgress['stage'],
    progress: number,
    message: string,
    error?: string
  ): void {
    const event: InstallProgress = { stage, progress, message, error };
    this.emit('progress', event);
    logger.info(`[CoPaw Install] ${stage}: ${message} (${progress}%)`);
  }
}

// Singleton instance
let installerInstance: CoPawInstaller | null = null;

export function getCoPawInstaller(): CoPawInstaller {
  if (!installerInstance) {
    installerInstance = new CoPawInstaller();
  }
  return installerInstance;
}
