/**
 * Backend Manager
 * Unified manager for different AI agent backends
 * Provides backward compatibility with GatewayManager interface
 */
import { EventEmitter } from 'events';
import { AgentBackend, BackendStatus, BackendHealth } from './backend';
import { createCoPawBackend } from './copaw-backend';
import { logger } from '../utils/logger';

/**
 * Supported backend types
 */
export type BackendType = 'copaw' | 'openclaw';

/**
 * Backend Manager configuration
 */
export interface BackendManagerConfig {
  type: BackendType;
  port?: number;
  autoStart?: boolean;
}

/**
 * Backend Manager Events (compatible with GatewayManager)
 */
export interface BackendManagerEvents {
  status: (status: BackendStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: { method: string; params?: unknown }) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
  'install:progress': (data: { stage: string; progress: number; message: string }) => void;
}

/**
 * Backend Manager
 * Manages the lifecycle of different AI agent backends
 */
export class BackendManager extends EventEmitter {
  private backend: AgentBackend | null = null;
  private config: BackendManagerConfig;
  private initialized = false;

  constructor(config: BackendManagerConfig = { type: 'copaw' }) {
    super();
    this.config = config;
  }

  /**
   * Get current backend type
   */
  getBackendType(): BackendType {
    return this.config.type;
  }

  /**
   * Get the underlying backend instance
   */
  getBackend(): AgentBackend | null {
    return this.backend;
  }

  /**
   * Initialize the backend
   */
  async initialize(): Promise<void> {
    if (this.initialized && this.backend) {
      return;
    }

    logger.info(`Initializing backend: ${this.config.type}`);

    // Create backend based on type
    switch (this.config.type) {
      case 'copaw':
        this.backend = createCoPawBackend(this.config.port);
        break;
      case 'openclaw':
        // For now, throw an error as we're replacing OpenClaw
        throw new Error('OpenClaw backend is deprecated. Please use CoPaw.');
      default:
        throw new Error(`Unknown backend type: ${this.config.type}`);
    }

    // Forward all backend events
    this.forwardEvents();
    
    this.initialized = true;
    logger.info(`Backend initialized: ${this.config.type}`);
  }

  /**
   * Forward events from backend to manager
   */
  private forwardEvents(): void {
    if (!this.backend) return;

    const events = [
      'status',
      'message',
      'notification',
      'exit',
      'error',
      'channel:status',
      'chat:message',
      'install:progress',
    ];

    for (const event of events) {
      this.backend.on(event, (...args: unknown[]) => {
        this.emit(event, ...args);
      });
    }
  }

  // Proxy methods to backend

  /**
   * Get current backend status
   */
  getStatus(): BackendStatus {
    if (!this.backend) {
      return {
        state: 'stopped',
        port: this.config.port || 8088,
        backendType: this.config.type,
      };
    }
    return this.backend.getStatus();
  }

  /**
   * Check if backend is connected
   */
  isConnected(): boolean {
    return this.backend?.isConnected() ?? false;
  }

  /**
   * Check if backend is installed
   */
  async isInstalled(): Promise<boolean> {
    if (!this.backend) {
      await this.initialize();
    }
    return this.backend?.isInstalled() ?? false;
  }

  /**
   * Install the backend
   */
  async install(): Promise<void> {
    if (!this.backend) {
      await this.initialize();
    }
    return this.backend?.install();
  }

  /**
   * Start the backend
   */
  async start(): Promise<void> {
    if (!this.backend) {
      await this.initialize();
    }
    return this.backend?.start();
  }

  /**
   * Stop the backend
   */
  async stop(): Promise<void> {
    return this.backend?.stop();
  }

  /**
   * Restart the backend
   */
  async restart(): Promise<void> {
    return this.backend?.restart();
  }

  /**
   * Debounced restart
   */
  debouncedRestart(delayMs?: number): void {
    this.backend?.debouncedRestart(delayMs);
  }

  /**
   * Check backend health
   */
  async checkHealth(): Promise<BackendHealth> {
    if (!this.backend) {
      return { ok: false, error: 'Backend not initialized' };
    }
    return this.backend.checkHealth();
  }

  /**
   * Make an RPC call to the backend
   * This provides backward compatibility with GatewayManager.rpc()
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.backend) {
      throw new Error('Backend not initialized');
    }
    return this.backend.rpc<T>(method, params, timeoutMs);
  }

  /**
   * Send a chat message
   */
  async sendMessage(
    sessionId: string,
    message: string,
    options?: { userId?: string; channel?: string; media?: Array<{ filePath: string; mimeType: string; fileName: string; base64?: string }> }
  ): Promise<unknown> {
    if (!this.backend) {
      throw new Error('Backend not initialized');
    }
    return this.backend.sendMessage(sessionId, message, options);
  }

  /**
   * Switch to a different backend type
   * This will stop the current backend and start the new one
   */
  async switchBackend(type: BackendType, port?: number): Promise<void> {
    logger.info(`Switching backend from ${this.config.type} to ${type}`);

    // Stop current backend
    if (this.backend) {
      await this.backend.stop();
      this.backend.removeAllListeners();
      this.backend = null;
    }

    // Update config
    this.config.type = type;
    if (port !== undefined) {
      this.config.port = port;
    }

    // Initialize new backend
    this.initialized = false;
    await this.initialize();

    // Start if auto-start is enabled
    if (this.config.autoStart) {
      await this.start();
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    if (this.backend) {
      await this.backend.stop();
      this.backend.removeAllListeners();
      this.backend = null;
    }
    this.initialized = false;
    this.removeAllListeners();
  }
}

// Singleton instance
let backendManagerInstance: BackendManager | null = null;

/**
 * Get or create the global BackendManager instance
 */
export function getBackendManager(config?: BackendManagerConfig): BackendManager {
  if (!backendManagerInstance) {
    backendManagerInstance = new BackendManager(config || { type: 'copaw' });
  }
  return backendManagerInstance;
}

/**
 * Reset the global BackendManager instance
 * Useful for testing or when switching backend types
 */
export async function resetBackendManager(): Promise<void> {
  if (backendManagerInstance) {
    await backendManagerInstance.dispose();
    backendManagerInstance = null;
  }
}

// Re-export types for convenience
export type { BackendStatus, BackendHealth, AgentBackend } from './backend';
