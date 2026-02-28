/**
 * Gateway/Backend Type Definitions
 * Types for Backend communication and data structures
 * Compatible with both OpenClaw and CoPaw backends
 */

/**
 * Backend type
 */
export type BackendType = 'openclaw' | 'copaw';

/**
 * Gateway/Backend connection status
 */
export interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting' | 'installing';
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  backendType?: BackendType;
}

/**
 * Gateway RPC response
 */
export interface GatewayRpcResponse<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Gateway health check response
 */
export interface GatewayHealth {
  ok: boolean;
  error?: string;
  uptime?: number;
  version?: string;
}

/**
 * Gateway notification (server-initiated event)
 */
export interface GatewayNotification {
  method: string;
  params?: unknown;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'ollama' | 'custom' | 'dashscope' | 'qwen';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
}

/**
 * Installation progress event
 */
export interface InstallProgress {
  stage: 'preparing' | 'creating-venv' | 'installing-copaw' | 'initializing' | 'complete' | 'error';
  progress: number;
  message: string;
  error?: string;
}

/**
 * CoPaw status
 */
export interface CoPawStatus {
  installed: boolean;
  venvExists: boolean;
  binPath: string;
  homeDir: string;
  version?: string;
}
