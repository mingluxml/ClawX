/**
 * CoPaw Backend Implementation
 * HTTP/REST-based backend adapter for CoPaw AI agent
 */
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  AgentBackend,
  BackendStatus,
  BackendHealth,
  ChatMessage,
  ChatSession,
  ChannelConfig,
  SkillInfo,
  CronJob,
} from './backend';
import {
  getCoPawBinPath,
  getCoPawHomeDir,
  getCoPawConfigPath,
  isCoPawInstalled,
} from '../utils/copaw-paths';
import { getCoPawInstaller, InstallProgress } from '../utils/copaw-installer';
import { logger } from '../utils/logger';
import { quoteForCmd, needsWinShell } from '../utils/paths';

/**
 * CoPaw API configuration
 */
const COPAW_DEFAULT_PORT = 8088;
const COPAW_API_TIMEOUT = 30000;
const COPAW_HEALTH_CHECK_INTERVAL = 30000;

/**
 * CoPaw Backend
 * Implements AgentBackend interface for CoPaw HTTP API
 */
export class CoPawBackend extends EventEmitter implements AgentBackend {
  readonly backendType = 'copaw' as const;
  
  private process: ChildProcess | null = null;
  private status: BackendStatus;
  private port: number;
  private baseUrl: string;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private startLock = false;
  private restartDebounceTimer: NodeJS.Timeout | null = null;

  constructor(port: number = COPAW_DEFAULT_PORT) {
    super();
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.status = {
      state: 'stopped',
      port: this.port,
      backendType: 'copaw',
    };

    // Listen to installer progress events
    const installer = getCoPawInstaller();
    installer.on('progress', (progress: InstallProgress) => {
      this.emit('install:progress', {
        stage: progress.stage,
        progress: progress.progress,
        message: progress.message,
      });
    });
  }

  getStatus(): BackendStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === 'running';
  }

  async isInstalled(): Promise<boolean> {
    return isCoPawInstalled();
  }

  async install(): Promise<void> {
    if (await this.isInstalled()) {
      logger.info('CoPaw is already installed');
      return;
    }

    this.setStatus({ state: 'installing' });
    
    try {
      const installer = getCoPawInstaller();
      await installer.install();
      this.setStatus({ state: 'stopped' });
    } catch (error) {
      this.setStatus({ 
        state: 'error', 
        error: `Installation failed: ${error}` 
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('CoPaw start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('CoPaw already running, skipping start');
      return;
    }

    this.startLock = true;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setStatus({ state: 'starting', reconnectAttempts: 0 });

    try {
      // Check if CoPaw is installed
      if (!await this.isInstalled()) {
        logger.info('CoPaw not installed, starting installation...');
        await this.install();
      }

      // Check if CoPaw is already running
      const existing = await this.findExistingService();
      if (existing) {
        logger.info(`Found existing CoPaw service on port ${this.port}`);
        await this.verifyConnection();
        this.startHealthCheck();
        return;
      }

      // Start new CoPaw process
      logger.info('Starting new CoPaw process...');
      await this.startProcess();
      await this.waitForReady();
      await this.verifyConnection();
      this.startHealthCheck();
      
      logger.info('CoPaw started successfully');

    } catch (error) {
      logger.error('CoPaw start failed:', error);
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
    }
  }

  async stop(): Promise<void> {
    logger.info('CoPaw stop requested');
    this.shouldReconnect = false;
    this.clearAllTimers();

    // Try graceful shutdown via API
    if (this.status.state === 'running') {
      try {
        // CoPaw doesn't have a shutdown endpoint, so we just kill the process
      } catch (err) {
        logger.warn('Error during CoPaw shutdown:', err);
      }
    }

    // Kill process
    if (this.process) {
      const child = this.process;
      
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return resolve();
        }

        const pid = child.pid;
        logger.info(`Sending SIGTERM to CoPaw process (pid=${pid ?? 'unknown'})`);
        
        if (pid) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            // Group kill failed, fall back to individual kill
          }
        }
        child.kill('SIGTERM');

        const timeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            logger.warn('CoPaw did not exit in time, sending SIGKILL');
            if (pid) {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch { /* ignore */ }
            }
            child.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        child.once('error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (this.process === child) {
        this.process = null;
      }
    }

    this.setStatus({ 
      state: 'stopped', 
      error: undefined, 
      pid: undefined, 
      connectedAt: undefined, 
      uptime: undefined 
    });
  }

  async restart(): Promise<void> {
    logger.debug('CoPaw restart requested');
    await this.stop();
    await this.start();
  }

  debouncedRestart(delayMs = 2000): void {
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }
    logger.debug(`CoPaw restart debounced (will fire in ${delayMs}ms)`);
    this.restartDebounceTimer = setTimeout(() => {
      this.restartDebounceTimer = null;
      void this.restart().catch((err) => {
        logger.warn('Debounced CoPaw restart failed:', err);
      });
    }, delayMs);
  }

  async checkHealth(): Promise<BackendHealth> {
    try {
      const response = await this.httpGet('/api/version');
      if (response.ok) {
        const data = await response.json();
        return {
          ok: true,
          version: data.version,
          uptime: this.status.connectedAt
            ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
            : undefined,
        };
      }
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async rpc<T>(method: string, params?: unknown, timeoutMs = COPAW_API_TIMEOUT): Promise<T> {
    // Special handling for CoPaw API methods
    if (method === 'sessions.list') {
      const sessions = await this.listSessions();
      return { sessions } as T;
    }

    if (method === 'chat.history') {
      const p = params as { sessionKey?: string; limit?: number } | undefined;
      const sessionKey = p?.sessionKey || '';
      // Extract session_id from sessionKey format "agent:main:sessionId"
      const parts = sessionKey.split(':');
      const sessionId = parts.length >= 3 ? parts.slice(2).join(':') : sessionKey;
      const messages = await this.getChatHistory(sessionId, p?.limit);
      return { messages } as T;
    }

    if (method === 'chat.send') {
      const p = params as { sessionKey?: string; message?: string; deliver?: boolean; idempotencyKey?: string } | undefined;
      const sessionKey = p?.sessionKey || '';
      // Extract session_id from sessionKey format "agent:main:sessionId"
      const parts = sessionKey.split(':');
      const sessionId = parts.length >= 3 ? parts.slice(2).join(':') : sessionKey;
      const result = await this.sendMessage(sessionId, p?.message || '', { channel: 'console' });
      return result as T;
    }

    if (method === 'sessions.delete') {
      const p = params as { sessionKey?: string; chatId?: string } | undefined;
      const chatId = p?.chatId || '';
      await this.deleteSession(chatId);
      return {} as T;
    }

    // Special handling for skills.status - transform CoPaw format to ClawX format
    if (method === 'skills.status') {
      try {
        const response = await this.httpGet('/api/skills', timeoutMs);
        if (!response.ok) {
          throw new Error(`Failed to fetch skills: ${response.status}`);
        }
        const rawSkills = await response.json() as Array<{
          name: string;
          content?: string;
          source?: string;
          path?: string;
          enabled?: boolean;
        }>;

        // Transform to ClawX expected format
        const skills = (Array.isArray(rawSkills) ? rawSkills : []).map((skill) => {
          // Extract description from content (first paragraph or first 200 chars)
          let description = '';
          if (skill.content) {
            // Try to extract description from YAML frontmatter
            const descMatch = skill.content.match(/description:\s*["']?([^"'\n]+)["']?/);
            if (descMatch) {
              description = descMatch[1].trim();
            } else {
              // Fallback: use first non-empty line after frontmatter
              const lines = skill.content.split('\n');
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('---') && !trimmed.startsWith('#') && !trimmed.includes(':')) {
                  description = trimmed.slice(0, 200);
                  break;
                }
              }
            }
          }

          // Extract emoji from content metadata if present
          let emoji = '📦';
          if (skill.content) {
            const emojiMatch = skill.content.match(/["']emoji["']:\s*["']([^"']+)["']/);
            if (emojiMatch) {
              emoji = emojiMatch[1];
            }
          }

          return {
            skillKey: skill.name,
            slug: skill.name,
            name: skill.name,
            description: description || `${skill.name} skill`,
            disabled: skill.enabled === false,
            emoji: emoji,
            version: '1.0.0',
            author: undefined,
            config: {},
            bundled: skill.source === 'builtin',
            always: false,
          };
        });

        return { skills } as T;
      } catch (error) {
        logger.error('Failed to fetch skills.status:', error);
        return { skills: [] } as T;
      }
    }

    // Special handling for channels.status - read from config file
    if (method === 'channels.status') {
      try {
        const configPath = getCoPawConfigPath();
        let channelsConfig: Record<string, { enabled?: boolean; bot_prefix?: string }> = {};
        
        if (existsSync(configPath)) {
          const configContent = readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configContent);
          channelsConfig = config.channels || {};
        }

        // Transform to ClawX expected format
        const channelOrder = Object.keys(channelsConfig);
        const channels: Record<string, { configured: boolean; running: boolean }> = {};
        const channelAccounts: Record<string, Array<{
          accountId: string;
          configured: boolean;
          connected: boolean;
          running: boolean;
          name: string;
        }>> = {};

        for (const channelId of channelOrder) {
          const channelConfig = channelsConfig[channelId];
          const isEnabled = channelConfig?.enabled === true;
          
          channels[channelId] = {
            configured: isEnabled,
            running: isEnabled,
          };

          if (isEnabled) {
            channelAccounts[channelId] = [{
              accountId: 'default',
              configured: true,
              connected: true,
              running: true,
              name: channelId,
            }];
          }
        }

        return {
          channelOrder,
          channels,
          channelAccounts,
          channelDefaultAccountId: {},
        } as T;
      } catch (error) {
        logger.error('Failed to fetch channels.status:', error);
        return {
          channelOrder: [],
          channels: {},
          channelAccounts: {},
          channelDefaultAccountId: {},
        } as T;
      }
    }

    // Special handling for skills.update - enable/disable via CoPaw API
    if (method === 'skills.update') {
      const p = params as { skillKey?: string; enabled?: boolean } | undefined;
      if (p?.skillKey != null && p?.enabled != null) {
        const action = p.enabled ? 'enable' : 'disable';
        try {
          const response = await this.httpPost(`/api/skills/${p.skillKey}/${action}`, {}, timeoutMs);
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to ${action} skill: ${text}`);
          }
          logger.info(`Skill ${p.skillKey} ${action}d successfully`);
          return {} as T;
        } catch (error) {
          logger.error(`Failed to ${action} skill ${p.skillKey}:`, error);
          throw error;
        }
      }
      return {} as T;
    }

    // Map RPC methods to HTTP endpoints
    const endpoint = this.mapMethodToEndpoint(method);
    const httpMethod = this.mapMethodToHttpMethod(method);

    try {
      let response: Response;
      
      if (httpMethod === 'GET') {
        response = await this.httpGet(endpoint, timeoutMs);
      } else {
        response = await this.httpPost(endpoint, params, timeoutMs);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return await response.json() as T;
    } catch (error) {
      logger.error(`CoPaw RPC error (${method}):`, error);
      throw error;
    }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    options: { userId?: string; channel?: string; media?: Array<{ filePath: string; mimeType: string; fileName: string; base64?: string }> } = {}
  ): Promise<unknown> {
    // CoPaw uses /api/agent/process endpoint with SSE response
    // Request format: { session_id, user_id, channel, input: [...] }
    const contentBlocks: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

    if (message) {
      contentBlocks.push({ type: 'text', text: message });
    }

    // Add media attachments as content blocks
    if (options.media && options.media.length > 0) {
      for (const m of options.media) {
        if (m.mimeType.startsWith('image/') && m.base64) {
          // Image: send as base64 content block
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: m.mimeType,
              data: m.base64,
            },
          });
        } else {
          // Non-image files: reference by path (CoPaw runs locally)
          contentBlocks.push({
            type: 'text',
            text: `[file attached: ${m.filePath} (${m.mimeType}, ${m.fileName})]`,
          });
        }
      }
    }

    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: '' });
    }

    const payload = {
      session_id: sessionId,
      user_id: options.userId || 'clawx-user',
      channel: options.channel || 'console',
      input: [
        {
          role: 'user',
          type: 'message',
          content: contentBlocks,
        },
      ],
    };

    // Use POST with SSE response handling
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COPAW_API_TIMEOUT * 10); // Longer timeout for SSE

    try {
      const response = await fetch(`${this.baseUrl}/api/agent/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to send message: ${errorText}`);
      }

      // Process SSE stream and emit events
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: unknown = null;
      
      // Track current message context
      let currentMsgId: string | null = null;
      let currentMsgType: string | null = null; // 'reasoning' | 'message' | 'function_call'
      
      // Aggregate content by message type
      let aggregatedText = '';
      let aggregatedThinking = '';
      let currentToolUse: { id: string; name: string; input: string } | null = null;
      let toolResults: Map<string, unknown> = new Map();
      
      let lastEmitTime = 0;
      const EMIT_INTERVAL = 100; // Emit at most every 100ms

      const emitDelta = () => {
        // Build content array with all accumulated blocks
        const contentBlocks: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }> = [];
        
        if (aggregatedThinking) {
          contentBlocks.push({ type: 'thinking', thinking: aggregatedThinking });
        }
        if (aggregatedText) {
          contentBlocks.push({ type: 'text', text: aggregatedText });
        }
        if (currentToolUse) {
          try {
            const input = currentToolUse.input ? JSON.parse(currentToolUse.input) : {};
            contentBlocks.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input,
            });
          } catch {
            contentBlocks.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: currentToolUse.input,
            });
          }
        }
        
        if (contentBlocks.length > 0) {
          this.emit('chat:message', {
            state: 'delta',
            message: {
              role: 'assistant',
              content: contentBlocks,
            },
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              // Handle message objects (start of a new message block)
              if (data.object === 'message') {
                currentMsgId = data.id || null;
                currentMsgType = data.type || null;
                
                // Handle tool use message
                if (data.type === 'function_call' && data.name) {
                  currentToolUse = {
                    id: data.id || `tool-${Date.now()}`,
                    name: data.name,
                    input: '',
                  };
                }
              }
              
              // Handle content deltas
              if (data.object === 'content' && data.delta === true) {
                if (data.type === 'text' && data.text) {
                  // Check if this is thinking content based on current message type
                  if (currentMsgType === 'reasoning') {
                    aggregatedThinking += data.text;
                  } else {
                    aggregatedText += data.text;
                  }
                  
                  // Throttle emissions
                  const now = Date.now();
                  if (now - lastEmitTime >= EMIT_INTERVAL) {
                    emitDelta();
                    lastEmitTime = now;
                  }
                } else if (data.type === 'input_json' && data.text && currentToolUse) {
                  // Tool input being streamed
                  currentToolUse.input += data.text;
                }
              }
              
              // Handle tool results
              if (data.object === 'message' && data.type === 'function_call_output') {
                const toolId = data.call_id || data.id;
                if (toolId) {
                  toolResults.set(toolId, data.output || data.content);
                }
              }
              
              // Handle response completion
              if (data.object === 'response' && data.status === 'completed') {
                // Emit any remaining content
                emitDelta();
                
                // Build final content with tool results
                const finalContent: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; output?: unknown }> = [];
                
                if (aggregatedThinking) {
                  finalContent.push({ type: 'thinking', thinking: aggregatedThinking });
                }
                if (aggregatedText) {
                  finalContent.push({ type: 'text', text: aggregatedText });
                }
                if (currentToolUse) {
                  try {
                    const input = currentToolUse.input ? JSON.parse(currentToolUse.input) : {};
                    const output = toolResults.get(currentToolUse.id);
                    finalContent.push({
                      type: 'tool_use',
                      id: currentToolUse.id,
                      name: currentToolUse.name,
                      input,
                      output,
                    });
                  } catch {
                    finalContent.push({
                      type: 'tool_use',
                      id: currentToolUse.id,
                      name: currentToolUse.name,
                      input: currentToolUse.input,
                    });
                  }
                }
                
                finalResult = data;
                this.emit('chat:message', {
                  state: 'final',
                  message: data.output || {
                    role: 'assistant',
                    content: finalContent.length > 0 ? finalContent : [{ type: 'text', text: aggregatedText }],
                  },
                });
              } else if (data.object === 'message' && data.type === 'message' && data.status === 'completed') {
                // Alternative final message format
                emitDelta();
                
                this.emit('chat:message', {
                  state: 'final',
                  message: {
                    role: data.role || 'assistant',
                    content: data.content,
                  },
                });
              }
            } catch {
              // Ignore parse errors for incomplete JSON
            }
          }
        }
      }

      // Emit any remaining aggregated content
      emitDelta();

      return finalResult || { success: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getChatHistory(sessionId: string, _limit?: number): Promise<ChatMessage[]> {
    // CoPaw stores chat history in local JSON files at ~/.copaw/sessions/
    // File format: {user_id}_{session_id}.json
    try {
      const homeDir = getCoPawHomeDir();
      const sessionsDir = join(homeDir, 'sessions');
      
      // Try to find the session file - check common patterns
      // ClawX uses 'clawx-user' as user_id when sending messages
      const possibleFiles = [
        join(sessionsDir, `clawx-user_${sessionId}.json`),
        join(sessionsDir, `main_${sessionId}.json`),
        join(sessionsDir, `default_${sessionId}.json`),
        join(sessionsDir, `${sessionId}.json`),
      ];
      
      let sessionData: unknown = null;
      for (const filePath of possibleFiles) {
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, 'utf-8');
            sessionData = JSON.parse(content);
            break;
          } catch {
            continue;
          }
        }
      }
      
      if (!sessionData) {
        return [];
      }
      
      // Extract messages from CoPaw session format
      // Format: { agent: { memory: { content: [[msg, response], ...] } } }
      const data = sessionData as {
        agent?: {
          memory?: {
            content?: Array<Array<unknown>>;
          };
        };
      };
      
      const messages: ChatMessage[] = [];
      const memoryContent = data?.agent?.memory?.content || [];
      
      for (const turn of memoryContent) {
        if (!Array.isArray(turn)) continue;
        for (const item of turn) {
          // Skip empty arrays and non-object items
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          
          const msg = item as {
            id?: string;
            role?: string;
            content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; output?: unknown }>;
            timestamp?: string;
          };
          
          // Must have role and content to be a valid message
          if (!msg.role || !msg.content) continue;
          
          // Return the full content array to preserve thinking, tool_use, etc.
          // Filter out empty blocks but keep all types
          const filteredContent = msg.content.filter(block => {
            if (block.type === 'text' && block.text) return true;
            if (block.type === 'thinking' && block.thinking) return true;
            if (block.type === 'tool_use' && block.name) return true;
            if (block.type === 'tool_result') return true;
            return false;
          });
          
          // Skip messages with no displayable content
          if (filteredContent.length === 0) continue;
          
          messages.push({
            role: msg.role as 'user' | 'assistant' | 'system',
            content: filteredContent,
            timestamp: msg.timestamp,
          });
        }
      }
      
      return messages;
    } catch (error) {
      logger.warn(`Failed to load chat history for session ${sessionId}:`, error);
      return [];
    }
  }

  async listSessions(): Promise<ChatSession[]> {
    // CoPaw uses /api/chats endpoint for chat list
    const response = await this.httpGet('/api/chats');
    
    if (!response.ok) {
      throw new Error(`Failed to list sessions: ${response.status}`);
    }

    const chats = await response.json() as Array<{
      id: string;
      name: string;
      session_id: string;
      user_id: string;
      channel: string;
      created_at: string;
      updated_at: string;
    }>;
    
    // Convert CoPaw chat format to ClawX session format
    return chats.map(chat => ({
      id: chat.id,
      key: `agent:main:${chat.session_id}`,
      label: chat.name,
      displayName: chat.name,
      sessionId: chat.session_id,
      userId: chat.user_id,
      channel: chat.channel,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Try to delete via CoPaw API first
    try {
      const response = await this.httpDelete(`/api/chats/${sessionId}`);
      if (response.ok) {
        logger.info(`Deleted session via API: ${sessionId}`);
        return;
      }
    } catch {
      // API delete not available, fall back to file deletion
    }

    // Fall back: delete session file from disk
    try {
      const homeDir = getCoPawHomeDir();
      const sessionsDir = join(homeDir, 'sessions');
      
      if (!existsSync(sessionsDir)) return;

      // Find and delete matching session files
      const files = readdirSync(sessionsDir);
      let deleted = false;
      for (const file of files) {
        if (file.includes(sessionId) && file.endsWith('.json')) {
          const filePath = join(sessionsDir, file);
          unlinkSync(filePath);
          logger.info(`Deleted session file: ${filePath}`);
          deleted = true;
        }
      }
      
      if (!deleted) {
        logger.warn(`No session file found for: ${sessionId}`);
      }
    } catch (error) {
      logger.error(`Failed to delete session ${sessionId}:`, error);
      throw error;
    }
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const response = await this.httpGet('/api/config');
    
    if (!response.ok) {
      throw new Error(`Failed to get config: ${response.status}`);
    }

    return await response.json();
  }

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    const response = await this.httpPut('/api/config', config);
    
    if (!response.ok) {
      throw new Error(`Failed to update config: ${response.status}`);
    }
  }

  async listChannels(): Promise<ChannelConfig[]> {
    const config = await this.getConfig();
    const channels = config.channels as Record<string, unknown> || {};
    
    return Object.entries(channels).map(([id, cfg]) => {
      const channelCfg = cfg as Record<string, unknown>;
      return {
        id,
        type: id,
        enabled: channelCfg.enabled as boolean || false,
        credentials: channelCfg.credentials as Record<string, unknown>,
      };
    });
  }

  async setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
    const config = await this.getConfig();
    const channels = config.channels as Record<string, unknown> || {};
    
    if (channels[channelId]) {
      (channels[channelId] as Record<string, unknown>).enabled = enabled;
      await this.updateConfig({ channels });
    }
  }

  async listSkills(): Promise<SkillInfo[]> {
    const response = await this.httpGet('/api/skills');
    
    if (!response.ok) {
      throw new Error(`Failed to list skills: ${response.status}`);
    }

    const data = await response.json();
    return (data.skills || []).map((skill: Record<string, unknown>) => ({
      id: skill.name as string,
      name: skill.name as string,
      description: skill.description as string,
      version: skill.version as string,
      enabled: skill.enabled as boolean ?? true,
    }));
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
    // CoPaw skill enable/disable is done via config
    logger.info(`Setting skill ${skillId} enabled=${enabled}`);
    // This would require updating the skills configuration
  }

  async listCronJobs(): Promise<CronJob[]> {
    const response = await this.httpGet('/api/cron/jobs');
    
    if (!response.ok) {
      throw new Error(`Failed to list cron jobs: ${response.status}`);
    }

    const data = await response.json();
    return (data.jobs || []).map((job: Record<string, unknown>) => ({
      id: job.id as string,
      name: job.name as string,
      schedule: job.schedule as string,
      enabled: job.enabled as boolean ?? true,
      lastRun: job.last_run as string,
      nextRun: job.next_run as string,
    }));
  }

  async createCronJob(job: Omit<CronJob, 'id'>): Promise<CronJob> {
    const response = await this.httpPost('/api/cron/jobs', job);
    
    if (!response.ok) {
      throw new Error(`Failed to create cron job: ${response.status}`);
    }

    return await response.json();
  }

  async deleteCronJob(jobId: string): Promise<void> {
    const response = await this.httpDelete(`/api/cron/jobs/${jobId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to delete cron job: ${response.status}`);
    }
  }

  // Private methods

  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
  }

  private setStatus(update: Partial<BackendStatus>): void {
    const previousState = this.status.state;
    this.status = { ...this.status, ...update };

    if (this.status.state === 'running' && this.status.connectedAt) {
      this.status.uptime = Date.now() - this.status.connectedAt;
    }

    this.emit('status', this.status);

    if (previousState !== this.status.state) {
      logger.debug(`CoPaw state changed: ${previousState} -> ${this.status.state}`);
    }
  }

  private async findExistingService(): Promise<boolean> {
    try {
      const response = await this.httpGet('/api/version', 2000);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async startProcess(): Promise<void> {
    const binPath = getCoPawBinPath();
    
    if (!existsSync(binPath)) {
      throw new Error(`CoPaw binary not found at: ${binPath}`);
    }

    const args = ['app', '--host', '127.0.0.1', '--port', String(this.port)];
    const useShell = needsWinShell(binPath);
    const spawnCmd = useShell ? quoteForCmd(binPath) : binPath;
    const spawnArgs = useShell ? args.map(a => quoteForCmd(a)) : args;

    logger.info(`Starting CoPaw process: ${binPath} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      this.process = spawn(spawnCmd, spawnArgs, {
        cwd: getCoPawHomeDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: useShell,
        env: {
          ...process.env,
          COPAW_PORT: String(this.port),
        },
      });

      const child = this.process;

      child.on('error', (error) => {
        logger.error('CoPaw process spawn error:', error);
        reject(error);
      });

      child.on('exit', (code, signal) => {
        const expected = !this.shouldReconnect || this.status.state === 'stopped';
        const level = expected ? logger.info : logger.warn;
        level(`CoPaw process exited (code=${code}, signal=${signal}, expected=${expected})`);
        
        if (this.process === child) {
          this.process = null;
        }
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });

      child.stderr?.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
          logger.debug(`[CoPaw stderr] ${line}`);
        }
      });

      child.stdout?.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
          logger.debug(`[CoPaw stdout] ${line}`);
        }
      });

      if (child.pid) {
        logger.info(`CoPaw process started (pid=${child.pid})`);
        this.setStatus({ pid: child.pid });
      }

      resolve();
    });
  }

  private async waitForReady(retries = 240, interval = 250): Promise<void> {
    const child = this.process;
    
    for (let i = 0; i < retries; i++) {
      // Check if process exited
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`CoPaw process exited before becoming ready`);
      }

      try {
        const response = await this.httpGet('/api/version', 2000);
        if (response.ok) {
          logger.debug(`CoPaw ready after ${i + 1} attempt(s)`);
          return;
        }
      } catch {
        // Not ready yet
      }

      if (i > 0 && i % 20 === 0) {
        logger.debug(`Still waiting for CoPaw... (attempt ${i + 1}/${retries})`);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`CoPaw failed to start after ${retries} retries`);
  }

  private async verifyConnection(): Promise<void> {
    const health = await this.checkHealth();
    
    if (!health.ok) {
      throw new Error(`CoPaw health check failed: ${health.error}`);
    }

    this.setStatus({
      state: 'running',
      connectedAt: Date.now(),
      version: health.version,
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (this.status.state !== 'running') {
        return;
      }

      try {
        const health = await this.checkHealth();
        if (!health.ok) {
          logger.warn(`CoPaw health check failed: ${health.error}`);
          this.emit('error', new Error(health.error || 'Health check failed'));
        }
      } catch (error) {
        logger.error('CoPaw health check error:', error);
      }
    }, COPAW_HEALTH_CHECK_INTERVAL);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    if (this.reconnectAttempts >= 10) {
      logger.error('CoPaw reconnect failed: max attempts reached');
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts,
      });
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    logger.warn(`Scheduling CoPaw reconnect attempt ${this.reconnectAttempts}/10 in ${delay}ms`);
    this.setStatus({ state: 'reconnecting', reconnectAttempts: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const existing = await this.findExistingService();
        if (existing) {
          await this.verifyConnection();
          this.reconnectAttempts = 0;
          this.startHealthCheck();
          return;
        }

        await this.startProcess();
        await this.waitForReady();
        await this.verifyConnection();
        this.reconnectAttempts = 0;
        this.startHealthCheck();
      } catch (error) {
        logger.error('CoPaw reconnection attempt failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // HTTP helpers

  private async httpGet(endpoint: string, timeoutMs = COPAW_API_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async httpPost(endpoint: string, body?: unknown, timeoutMs = COPAW_API_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async httpPut(endpoint: string, body?: unknown, timeoutMs = COPAW_API_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async httpDelete(endpoint: string, timeoutMs = COPAW_API_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Method mapping helpers

  private mapMethodToEndpoint(method: string): string {
    const mapping: Record<string, string> = {
      'chat.send': '/api/chats',  // Will be handled specially with session lookup
      'chat.history': '/api/chats',  // Will be handled specially with session lookup
      'sessions.list': '/api/chats',
      'config.get': '/api/config',
      'config.set': '/api/config',
      'channel.list': '/api/config',
      'skill.list': '/api/skills',
      'cron.list': '/api/cron/jobs',
      'cron.create': '/api/cron/jobs',
      'health': '/api/version',
    };
    return mapping[method] || `/api/${method.replace('.', '/')}`;
  }

  private mapMethodToHttpMethod(method: string): 'GET' | 'POST' | 'PUT' | 'DELETE' {
    const postMethods = ['chat.send', 'config.set', 'cron.create', 'skill.install'];
    const deleteMethods = ['cron.delete', 'skill.uninstall'];
    
    if (postMethods.includes(method)) return 'POST';
    if (deleteMethods.includes(method)) return 'DELETE';
    return 'GET';
  }

  private convertToChatMessages(messages: unknown[]): ChatMessage[] {
    return messages.map((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      return {
        role: m.role as 'user' | 'assistant' | 'system',
        content: this.extractContent(m.content),
        timestamp: m.timestamp as string,
      };
    });
  }

  private extractContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
        // Also extract thinking content for display
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          // Optionally include thinking in a special format
          // For now, we skip thinking blocks as they are shown separately in UI
        }
      }
      return texts.join('');
    }
    if (content === null || content === undefined) {
      return '';
    }
    return String(content);
  }
}

// Factory function
export function createCoPawBackend(port?: number): CoPawBackend {
  return new CoPawBackend(port);
}
