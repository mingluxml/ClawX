/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, nativeImage, session, shell } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBackendManager } from '../gateway/backend-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';

// ESM compatibility: define __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { deviceOAuthManager, setCoPawPort } from '../utils/device-oauth';

import { isQuitting, setQuitting } from './app-state';

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();

// Global references
let mainWindow: BrowserWindow | null = null;
const backendManager = getBackendManager({ type: 'copaw', port: 8088 });

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  const iconsDir = getIconsDir();

  if (process.platform === 'darwin') {
    // In packaged mode macOS uses the app bundle icon automatically.
    // In dev mode we load it manually so the custom icon is visible.
    if (app.isPackaged) return undefined;
    const icon = nativeImage.createFromPath(join(iconsDir, 'icon.png'));
    return icon.isEmpty() ? undefined : icon;
  }

  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    frame: isMac,
    show: false,
  });

  // Show window when ready to prevent visual flash
  win.once('ready-to-show', () => {
    win.show();
  });

  // Handle external links
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  logger.info('=== ClawX Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`
  );

  // Warm up network optimization (non-blocking)
  void warmupNetworkOptimization();

  // Set application menu
  createMenu();

  // Set dock icon on macOS in dev mode
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(getIconsDir(), 'icon.png'));
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  // Create the main window
  mainWindow = createWindow();

  // Create system tray
  createTray(mainWindow);

  // Override security headers for the CoPaw backend console.
  // The URL filter ensures this callback only fires for backend requests,
  // avoiding unnecessary overhead on every other HTTP response.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:8088/*', 'http://localhost:8088/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    },
  );

  // Register IPC handlers
  registerIpcHandlers(backendManager, mainWindow);

  // Set up OAuth manager with window reference and CoPaw port
  deviceOAuthManager.setWindow(mainWindow);
  setCoPawPort(8088);

  // Restart backend when OAuth succeeds (so CoPaw picks up new provider config)
  deviceOAuthManager.on('oauth:success', () => {
    logger.info('[OAuth] Provider configured, restarting backend to apply changes...');
    backendManager.debouncedRestart(2000);
  });

  // Register update handlers
  registerUpdateHandlers(appUpdater, mainWindow);

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Minimize to tray on close instead of quitting (macOS & Windows)
  mainWindow.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Start backend automatically
  try {
    logger.debug('Auto-starting CoPaw backend...');
    await backendManager.start();
    logger.info('CoPaw backend auto-start succeeded');
  } catch (error) {
    logger.error('CoPaw backend auto-start failed:', error);
    mainWindow?.webContents.send('gateway:error', String(error));
  }

  // Forward install progress events to renderer
  backendManager.on('install:progress', (progress: { stage: string; progress: number; message: string }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend:install-progress', progress);
    }
  });
}

// Application lifecycle
app.whenReady().then(() => {
  initialize();

  // Register activate handler AFTER app is ready to prevent
  // "Cannot create BrowserWindow before app is ready" on macOS.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      // On macOS, clicking the dock icon should show the window if it's hidden
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  setQuitting();
  // Fire-and-forget: do not await backendManager.stop() here.
  // Awaiting inside before-quit can stall Electron's quit sequence.
  void backendManager.stop().catch((err) => {
    logger.warn('backendManager.stop() error during quit:', err);
  });
});

// Export for testing
export { mainWindow, backendManager };
