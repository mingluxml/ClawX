/**
 * Agent Backend Interface
 * Abstraction layer for different AI agent backends (OpenClaw, CoPaw, etc.)
 */
import { EventEmitter } from 'events';

/**
 * Backend connection status
 */
export interface BackendStatus {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting' | 'installing';
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  backendType: 'openclaw' | 'copaw';
}

/**
 * Backend health check response
 */
export interface BackendHealth {
  ok: boolean;
  error?: string;
  uptime?: number;
  version?: string;
}

/**
 * Chat message format (unified)
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | MessageContent[];
  timestamp?: string;
}

export interface MessageContent {
  type: 'text' | 'image' | 'file' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  url?: string;
  name?: string;
  id?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Chat session
 */
export interface ChatSession {
  id: string;
  userId?: string;
  channel: string;
  messages: ChatMessage[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Channel configuration
 */
export interface ChannelConfig {
  id: string;
  type: string;
  enabled: boolean;
  credentials?: Record<string, unknown>;
}

/**
 * Skill definition
 */
export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
}

/**
 * Cron job definition - aligned with CoPaw API
 */
export interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun?: {
    time: string;
    success: boolean;
    error?: string;
    duration?: number;
  };
  nextRun?: string;
  /** Target channel for task execution */
  channel?: string;
  /** Target session ID for task execution */
  sessionId?: string;
}

/**
 * Backend event types
 */
export interface BackendEvents {
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
 * Agent Backend Interface
 * All backend implementations must implement this interface
 */
export interface AgentBackend extends EventEmitter {
  /**
   * Get backend type identifier
   */
  readonly backendType: 'openclaw' | 'copaw';

  /**
   * Get current backend status
   */
  getStatus(): BackendStatus;

  /**
   * Check if backend is connected and ready
   */
  isConnected(): boolean;

  /**
   * Check if backend is installed
   */
  isInstalled(): Promise<boolean>;

  /**
   * Install the backend (if not already installed)
   */
  install(): Promise<void>;

  /**
   * Start the backend service
   */
  start(): Promise<void>;

  /**
   * Stop the backend service
   */
  stop(): Promise<void>;

  /**
   * Restart the backend service
   */
  restart(): Promise<void>;

  /**
   * Debounced restart
   */
  debouncedRestart(delayMs?: number): void;

  /**
   * Check backend health
   */
  checkHealth(): Promise<BackendHealth>;

  /**
   * Make an RPC call to the backend
   */
  rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;

  /**
   * Send a chat message
   */
  sendMessage(
    sessionId: string,
    message: string,
    options?: { userId?: string; channel?: string; media?: Array<{ filePath: string; mimeType: string; fileName: string; base64?: string }> }
  ): Promise<unknown>;

  /**
   * Get chat history
   */
  getChatHistory(sessionId: string, limit?: number): Promise<ChatMessage[]>;

  /**
   * List chat sessions
   */
  listSessions(): Promise<ChatSession[]>;

  /**
   * Get backend configuration
   */
  getConfig(): Promise<Record<string, unknown>>;

  /**
   * Update backend configuration
   */
  updateConfig(config: Record<string, unknown>): Promise<void>;

  /**
   * List available channels
   */
  listChannels(): Promise<ChannelConfig[]>;

  /**
   * Enable/disable a channel
   */
  setChannelEnabled(channelId: string, enabled: boolean): Promise<void>;

  /**
   * List available skills
   */
  listSkills(): Promise<SkillInfo[]>;

  /**
   * Enable/disable a skill
   */
  setSkillEnabled(skillId: string, enabled: boolean): Promise<void>;

  /**
   * List cron jobs
   */
  listCronJobs(): Promise<CronJob[]>;

  /**
   * Get a specific cron job
   */
  getCronJob(jobId: string): Promise<CronJob>;

  /**
   * Create a cron job
   */
  createCronJob(job: Omit<CronJob, 'id'>): Promise<CronJob>;

  /**
   * Update a cron job
   */
  updateCronJob(jobId: string, update: Partial<Omit<CronJob, 'id' | 'createdAt'>>): Promise<CronJob>;

  /**
   * Toggle cron job enable/disable state
   */
  toggleCronJob(jobId: string, enabled: boolean): Promise<CronJob>;

  /**
   * Trigger cron job manually
   */
  triggerCronJob(jobId: string): Promise<void>;

  /**
   * Delete a cron job
   */
  deleteCronJob(jobId: string): Promise<void>;
}

/**
 * Backend factory function type
 */
export type BackendFactory = () => AgentBackend;
