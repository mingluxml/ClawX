/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 * Adapted for CoPaw backend
 */
import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import crypto from 'node:crypto';
import { BackendManager } from '../gateway/backend-manager';
import {
  storeApiKey,
  deleteApiKey,
  hasApiKey,
  saveProvider,
  getProvider,
  deleteProvider,
  setDefaultProvider,
  getDefaultProvider,
  getAllProvidersWithKeyInfo,
  type ProviderConfig,
} from '../utils/secure-storage';
import { ensureDir } from '../utils/paths';
import { getCoPawHomeDir, getCoPawSkillsDir, getCoPawCustomizedSkillsDir, getCoPawStatus, getCoPawConfigPath } from '../utils/copaw-paths';
import { logger } from '../utils/logger';
import { checkUvInstalled, installUv, setupManagedPython } from '../utils/uv-setup';
import { getProviderConfig } from '../utils/provider-registry';
import { deviceOAuthManager, OAuthProviderType } from '../utils/device-oauth';
import { listConfiguredChannels, getChannelFormValues } from '../utils/channel-config';
import { getAllSkillConfigs } from '../utils/skill-config';
import { importSkillFromUrl } from '../utils/skill-importer';

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  backendManager: BackendManager,
  mainWindow: BrowserWindow
): void {
  // Backend/Gateway handlers (compatible naming for frontend)
  registerBackendHandlers(backendManager, mainWindow);

  // Provider handlers
  registerProviderHandlers(backendManager);

  // Shell handlers
  registerShellHandlers();

  // Dialog handlers
  registerDialogHandlers();

  // App handlers
  registerAppHandlers();

  // UV handlers
  registerUvHandlers();

  // Log handlers
  registerLogHandlers();

  // Skill handlers
  registerSkillHandlers(backendManager);

  // Cron task handlers
  registerCronHandlers(backendManager);

  // Channel handlers
  registerChannelHandlers();

  // Window control handlers
  registerWindowHandlers(mainWindow);

  // Device OAuth handlers
  registerDeviceOAuthHandlers(mainWindow);

  // File staging handlers
  registerFileHandlers();
}

/**
 * Backend/Gateway IPC handlers
 * Uses gateway:* channel names for frontend compatibility
 */
function registerBackendHandlers(backendManager: BackendManager, mainWindow: BrowserWindow): void {
  // Get Gateway/Backend status
  ipcMain.handle('gateway:status', () => {
    return backendManager.getStatus();
  });

  // Check if connected
  ipcMain.handle('gateway:isConnected', () => {
    return backendManager.isConnected();
  });

  // Check if installed
  ipcMain.handle('gateway:isInstalled', async () => {
    return await backendManager.isInstalled();
  });

  // Install backend
  ipcMain.handle('gateway:install', async () => {
    try {
      await backendManager.install();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Start backend
  ipcMain.handle('gateway:start', async () => {
    try {
      await backendManager.start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Stop backend
  ipcMain.handle('gateway:stop', async () => {
    try {
      await backendManager.stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Restart backend
  ipcMain.handle('gateway:restart', async () => {
    try {
      await backendManager.restart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // RPC call
  ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown, timeoutMs?: number) => {
    try {
      const result = await backendManager.rpc(method, params, timeoutMs);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Chat send with media
  ipcMain.handle('chat:sendWithMedia', async (_, params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    idempotencyKey: string;
    media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
  }) => {
    try {
      let message = params.message;
      const fileReferences: string[] = [];

      // Process media attachments
      if (params.media && params.media.length > 0) {
        const fsP = await import('fs/promises');
        for (const m of params.media) {
          const exists = await fsP.access(m.filePath).then(() => true, () => false);
          if (exists) {
            fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType})]`);
          }
        }
      }

      // Append file references to message
      if (fileReferences.length > 0) {
        const refs = fileReferences.join('\n');
        message = message ? `${message}\n\n${refs}` : refs;
      }

      const result = await backendManager.sendMessage(
        params.sessionKey,
        message,
        { channel: 'console' }
      );

      return { success: true, result };
    } catch (error) {
      logger.error(`[chat:sendWithMedia] Error: ${String(error)}`);
      return { success: false, error: String(error) };
    }
  });

  // Get the Console UI URL
  ipcMain.handle('gateway:getControlUiUrl', async () => {
    try {
      const status = backendManager.getStatus();
      const port = status.port || 8088;
      const url = `http://127.0.0.1:${port}/`;
      return { success: true, url, port };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Health check
  ipcMain.handle('gateway:health', async () => {
    try {
      const health = await backendManager.checkHealth();
      return { success: true, ...health };
    } catch (error) {
      return { success: false, ok: false, error: String(error) };
    }
  });

  // Backend status handlers
  ipcMain.handle('backend:status', () => {
    return backendManager.getStatus();
  });

  ipcMain.handle('backend:getType', () => {
    return backendManager.getBackendType();
  });

  // Forward backend events to renderer
  backendManager.on('status', (status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:status-changed', status);
    }
  });

  backendManager.on('message', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:message', message);
    }
  });

  backendManager.on('notification', (notification) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:notification', notification);
    }
  });

  backendManager.on('channel:status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:channel-status', data);
    }
  });

  backendManager.on('chat:message', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:chat-message', data);
    }
  });

  backendManager.on('exit', (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:exit', code);
    }
  });

  backendManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:error', error.message);
    }
  });

  backendManager.on('install:progress', (progress) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend:install-progress', progress);
    }
  });
}

/**
 * Provider IPC handlers
 */
function registerProviderHandlers(backendManager: BackendManager): void {
  // Save provider configuration
  ipcMain.handle('provider:save', async (_, config: ProviderConfig) => {
    try {
      await saveProvider(config);
      if (config.apiKey) {
        await storeApiKey(config.id, config.apiKey);
      }
      // Restart backend to apply changes
      backendManager.debouncedRestart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get provider configuration
  ipcMain.handle('provider:get', async (_, providerId: string) => {
    try {
      const config = await getProvider(providerId);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete provider
  ipcMain.handle('provider:delete', async (_, providerId: string) => {
    try {
      await deleteProvider(providerId);
      await deleteApiKey(providerId);
      backendManager.debouncedRestart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Set default provider
  ipcMain.handle('provider:setDefault', async (_, providerId: string) => {
    try {
      await setDefaultProvider(providerId);
      backendManager.debouncedRestart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get default provider
  ipcMain.handle('provider:getDefault', async () => {
    try {
      const providerId = await getDefaultProvider();
      return { success: true, providerId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List all providers
  ipcMain.handle('provider:list', async () => {
    try {
      const providers = await getAllProvidersWithKeyInfo();
      return { success: true, providers };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Store API key
  ipcMain.handle('provider:storeKey', async (_, providerId: string, apiKey: string) => {
    try {
      await storeApiKey(providerId, apiKey);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Check if provider has API key
  ipcMain.handle('provider:hasKey', async (_, providerId: string) => {
    try {
      const has = await hasApiKey(providerId);
      return { success: true, hasKey: has };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get provider config template
  ipcMain.handle('provider:getConfig', (_, providerType: string) => {
    try {
      const config = getProviderConfig(providerType);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Shell IPC handlers
 */
function registerShellHandlers(): void {
  // Open external URL
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open path in system file explorer
  ipcMain.handle('shell:showItemInFolder', (_, path: string) => {
    try {
      shell.showItemInFolder(path);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open path with default application
  ipcMain.handle('shell:openPath', async (_, path: string) => {
    try {
      const result = await shell.openPath(path);
      return { success: !result, error: result || undefined };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Dialog IPC handlers
 */
function registerDialogHandlers(): void {
  // Show open file dialog
  ipcMain.handle('dialog:openFile', async (_, options?: Electron.OpenDialogOptions) => {
    try {
      const result = await dialog.showOpenDialog(options || {});
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Show save file dialog
  ipcMain.handle('dialog:saveFile', async (_, options?: Electron.SaveDialogOptions) => {
    try {
      const result = await dialog.showSaveDialog(options || {});
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Show message box
  ipcMain.handle('dialog:showMessage', async (_, options: Electron.MessageBoxOptions) => {
    try {
      const result = await dialog.showMessageBox(options);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * App IPC handlers
 */
function registerAppHandlers(): void {
  // Get app version
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  // Get app name
  ipcMain.handle('app:getName', () => {
    return app.getName();
  });

  // Get app path
  ipcMain.handle('app:getPath', (_, name: Parameters<typeof app.getPath>[0]) => {
    return app.getPath(name);
  });

  // Check if packaged
  ipcMain.handle('app:isPackaged', () => {
    return app.isPackaged;
  });

  // Get platform
  ipcMain.handle('app:getPlatform', () => {
    return process.platform;
  });

  // Quit app
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  // Get CoPaw status
  ipcMain.handle('copaw:status', async () => {
    return await getCoPawStatus();
  });

  // Get CoPaw home directory
  ipcMain.handle('copaw:getHomeDir', () => {
    return getCoPawHomeDir();
  });

  // Get CoPaw skills directory (customized_skills for user-imported skills)
  ipcMain.handle('copaw:getSkillsDir', () => {
    const dir = getCoPawCustomizedSkillsDir();
    ensureDir(dir);
    return dir;
  });

  // Get CoPaw config path
  ipcMain.handle('copaw:getConfigPath', () => {
    return getCoPawConfigPath();
  });
}

/**
 * UV IPC handlers
 */
function registerUvHandlers(): void {
  // Check if UV is installed
  ipcMain.handle('uv:isInstalled', async () => {
    try {
      const installed = await checkUvInstalled();
      return { success: true, installed };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install UV
  ipcMain.handle('uv:install', async () => {
    try {
      await installUv();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Setup managed Python
  ipcMain.handle('uv:setupPython', async () => {
    try {
      await setupManagedPython();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Log IPC handlers
 */
function registerLogHandlers(): void {
  // Get recent logs
  ipcMain.handle('logs:getRecent', async (_, count = 100) => {
    try {
      const logs = logger.getRecentLogs?.(count) || [];
      return { success: true, logs };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get log file path
  ipcMain.handle('logs:getPath', () => {
    try {
      const logPath = logger.getLogPath?.() || join(app.getPath('userData'), 'logs');
      return { success: true, path: logPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Skill IPC handlers
 */
function registerSkillHandlers(backendManager: BackendManager): void {
  // List skills
  ipcMain.handle('skill:list', async () => {
    try {
      const backend = backendManager.getBackend();
      if (!backend) {
        return { success: false, error: 'Backend not initialized' };
      }
      const skills = await backend.listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Enable/disable skill
  ipcMain.handle('skill:setEnabled', async (_, skillId: string, enabled: boolean) => {
    try {
      const backend = backendManager.getBackend();
      if (!backend) {
        return { success: false, error: 'Backend not initialized' };
      }
      await backend.setSkillEnabled(skillId, enabled);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get all skill configs
  ipcMain.handle('skill:getAllConfigs', async () => {
    try {
      const configs = await getAllSkillConfigs();
      return configs;
    } catch (error) {
      logger.error('Failed to get all skill configs:', error);
      return {};
    }
  });

  // Import skill from Git URL
  ipcMain.handle('skill:importFromUrl', async (_, url: string) => {
    try {
      const result = await importSkillFromUrl(url);
      if (result.success) {
        backendManager.debouncedRestart();
      }
      return result;
    } catch (error) {
      logger.error('Failed to import skill from URL:', error);
      return { success: false, error: String(error), errorCode: 'CLONE_FAILED' };
    }
  });
}

/**
 * Cron task IPC handlers
 */
function registerCronHandlers(backendManager: BackendManager): void {
  // List cron jobs
  ipcMain.handle('cron:list', async () => {
    try {
      const backend = backendManager.getBackend();
      if (!backend) {
        return { success: false, error: 'Backend not initialized' };
      }
      const jobs = await backend.listCronJobs();
      return { success: true, jobs };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Create cron job
  ipcMain.handle('cron:create', async (_, job: { name: string; schedule: string; enabled?: boolean }) => {
    try {
      const backend = backendManager.getBackend();
      if (!backend) {
        return { success: false, error: 'Backend not initialized' };
      }
      const created = await backend.createCronJob({
        name: job.name,
        schedule: job.schedule,
        enabled: job.enabled ?? true,
      });
      return { success: true, job: created };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete cron job
  ipcMain.handle('cron:delete', async (_, jobId: string) => {
    try {
      const backend = backendManager.getBackend();
      if (!backend) {
        return { success: false, error: 'Backend not initialized' };
      }
      await backend.deleteCronJob(jobId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Channel IPC handlers
 */
function registerChannelHandlers(): void {
  // List configured channels
  ipcMain.handle('channel:listConfigured', async () => {
    try {
      const channels = await listConfiguredChannels();
      return { success: true, channels };
    } catch (error) {
      logger.error('Failed to list configured channels:', error);
      return { success: false, channels: [] };
    }
  });

  // Get form values for a channel type
  ipcMain.handle('channel:getFormValues', async (_, channelType: string) => {
    try {
      const values = await getChannelFormValues(channelType);
      return { success: true, values: values || {} };
    } catch (error) {
      logger.error('Failed to get channel form values:', error);
      return { success: false, values: {} };
    }
  });

  // Cancel WhatsApp QR scanning (no-op for CoPaw)
  ipcMain.handle('channel:cancelWhatsAppQr', async () => {
    return { success: true };
  });
}

/**
 * Window control IPC handlers
 */
function registerWindowHandlers(mainWindow: BrowserWindow): void {
  // Minimize window
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  // Maximize/restore window
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.restore();
    } else {
      mainWindow.maximize();
    }
  });

  // Close window
  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  // Check if maximized
  ipcMain.handle('window:isMaximized', () => {
    return mainWindow.isMaximized();
  });
}

/**
 * Device OAuth IPC handlers
 */
function registerDeviceOAuthHandlers(mainWindow: BrowserWindow): void {
  // Set window reference for OAuth events
  deviceOAuthManager.setWindow(mainWindow);

  // Start OAuth flow (used by frontend ProvidersSettings.tsx)
  ipcMain.handle('provider:requestOAuth', async (_, provider: OAuthProviderType, region?: string) => {
    try {
      logger.info(`[IPC] provider:requestOAuth for ${provider}`);
      await deviceOAuthManager.startFlow(provider, (region as 'global' | 'cn') || 'global');
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Cancel OAuth flow
  ipcMain.handle('provider:cancelOAuth', async () => {
    try {
      await deviceOAuthManager.stopFlow();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
  ipcMain.handle('oauth:cancel', (_, provider: OAuthProviderType) => {
    deviceOAuthManager.cancelFlow(provider);
    return { success: true };
  });
}

/**
 * File staging IPC handlers
 */
function registerFileHandlers(): void {
  const stagingDir = join(app.getPath('userData'), 'staging');

  // Ensure staging directory exists
  if (!existsSync(stagingDir)) {
    mkdirSync(stagingDir, { recursive: true });
  }

  // Stage file for upload
  ipcMain.handle('file:stage', async (_, filePath: string) => {
    try {
      const fsP = await import('fs/promises');
      const fileName = basename(filePath);
      const ext = extname(fileName);
      const uniqueName = `${crypto.randomUUID()}${ext}`;
      const stagePath = join(stagingDir, uniqueName);
      
      await fsP.copyFile(filePath, stagePath);
      
      return { 
        success: true, 
        stagePath, 
        originalName: fileName,
        mimeType: getMimeType(ext),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Clean up staged file
  ipcMain.handle('file:cleanup', async (_, stagePath: string) => {
    try {
      const fsP = await import('fs/promises');
      await fsP.unlink(stagePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get staging directory
  ipcMain.handle('file:getStagingDir', () => {
    return stagingDir;
  });
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.md': 'text/markdown',
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}
