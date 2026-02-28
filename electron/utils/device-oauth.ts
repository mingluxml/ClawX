/**
 * Device OAuth Manager
 *
 * Implements OAuth Device Flow for MiniMax and Qwen providers,
 * bridging the OAuth access token to CoPaw as an API Key.
 *
 * Flow:
 * 1. User initiates OAuth from UI
 * 2. Device Flow runs (PKCE + polling)
 * 3. Token saved to electron-store
 * 4. Token synced to CoPaw via REST API (custom provider + api_key)
 * 5. Success event emitted to frontend
 */
import { EventEmitter } from 'events';
import { BrowserWindow, shell } from 'electron';
import { logger } from './logger';
import { saveProvider, getProvider, type ProviderConfig } from './secure-storage';
import { getProviderDefaultModel } from './provider-registry';
import { saveOAuthToken, getOAuthToken, isTokenExpired } from './oauth-store';
import {
    loginMiniMaxPortalOAuth,
    type MiniMaxOAuthToken,
    type MiniMaxRegion,
} from '../lib/oauth/minimax-oauth';
import {
    loginQwenPortalOAuth,
    type QwenOAuthToken,
} from '../lib/oauth/qwen-oauth';

export type OAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
export type { MiniMaxRegion };

/**
 * CoPaw provider mapping configuration
 */
interface CoPawProviderMapping {
    copawProviderId: string;
    name: string;
    defaultBaseUrl: string;
    models: Array<{ id: string; name: string }>;
}

const COPAW_PROVIDER_MAPPINGS: Record<string, CoPawProviderMapping> = {
    'minimax-portal': {
        copawProviderId: 'minimax-portal',
        name: 'MiniMax Portal (OAuth)',
        defaultBaseUrl: 'https://api.minimax.io/anthropic',
        models: [{ id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }],
    },
    'minimax-portal-cn': {
        copawProviderId: 'minimax-portal',
        name: 'MiniMax Portal (OAuth)',
        defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
        models: [{ id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }],
    },
    'qwen-portal': {
        copawProviderId: 'qwen-portal',
        name: 'Qwen Portal (OAuth)',
        defaultBaseUrl: 'https://portal.qwen.ai/v1',
        models: [{ id: 'coder-model', name: 'Qwen Coder' }],
    },
};

/**
 * Default CoPaw API port
 */
let copawPort = 8088;

/**
 * Set the CoPaw API port (called from BackendManager)
 */
export function setCoPawPort(port: number): void {
    copawPort = port;
}

// ─────────────────────────────────────────────────────────────
// CoPaw API helpers
// ─────────────────────────────────────────────────────────────

async function copawApiCall(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `http://127.0.0.1:${copawPort}${path}`;
    return fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
}

/**
 * Ensure a custom provider exists in CoPaw.
 * If it already exists (400), silently continue.
 */
async function ensureCoPawProvider(mapping: CoPawProviderMapping): Promise<void> {
    try {
        const resp = await copawApiCall('POST', '/models/custom-providers', {
            id: mapping.copawProviderId,
            name: mapping.name,
            default_base_url: mapping.defaultBaseUrl,
            api_key_prefix: '',
            models: mapping.models,
        });

        if (resp.ok) {
            logger.info(`[DeviceOAuth] Created CoPaw provider: ${mapping.copawProviderId}`);
        } else if (resp.status === 400) {
            // Provider already exists, this is fine
            logger.info(`[DeviceOAuth] CoPaw provider already exists: ${mapping.copawProviderId}`);
        } else {
            const text = await resp.text();
            logger.warn(`[DeviceOAuth] CoPaw create provider returned ${resp.status}: ${text}`);
        }
    } catch (err) {
        logger.warn(`[DeviceOAuth] Failed to create CoPaw provider (CoPaw may not be running):`, err);
    }
}

/**
 * Update the CoPaw provider's api_key and base_url
 */
async function syncTokenToCoPaw(copawProviderId: string, accessToken: string, baseUrl: string): Promise<boolean> {
    try {
        const resp = await copawApiCall('PUT', `/models/${copawProviderId}/config`, {
            api_key: accessToken,
            base_url: baseUrl,
        });

        if (resp.ok) {
            logger.info(`[DeviceOAuth] Synced token to CoPaw provider: ${copawProviderId}`);
            return true;
        } else {
            const text = await resp.text();
            logger.warn(`[DeviceOAuth] CoPaw config update returned ${resp.status}: ${text}`);
            return false;
        }
    } catch (err) {
        logger.warn(`[DeviceOAuth] Failed to sync token to CoPaw (CoPaw may not be running):`, err);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// DeviceOAuthManager
// ─────────────────────────────────────────────────────────────

class DeviceOAuthManager extends EventEmitter {
    private activeProvider: OAuthProviderType | null = null;
    private active: boolean = false;
    private mainWindow: BrowserWindow | null = null;

    setWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    async startFlow(provider: OAuthProviderType, region: MiniMaxRegion = 'global'): Promise<boolean> {
        if (this.active) {
            await this.stopFlow();
        }

        // Check if we have a valid non-expired token — just re-sync to CoPaw
        const existingToken = await getOAuthToken(provider);
        if (existingToken && !(await isTokenExpired(provider))) {
            logger.info(`[DeviceOAuth] Existing valid token for ${provider}, re-syncing to CoPaw`);
            try {
                const mapping = COPAW_PROVIDER_MAPPINGS[provider];
                if (mapping) {
                    await ensureCoPawProvider(mapping);
                    await syncTokenToCoPaw(mapping.copawProviderId, existingToken.access, existingToken.baseUrl);
                }
                // Emit success to frontend
                this.emitSuccess(provider);
                return true;
            } catch (err) {
                logger.warn(`[DeviceOAuth] Re-sync failed, running full flow:`, err);
            }
        }

        this.active = true;
        this.activeProvider = provider;

        try {
            if (provider === 'minimax-portal' || provider === 'minimax-portal-cn') {
                const actualRegion = provider === 'minimax-portal-cn' ? 'cn' : (region || 'global');
                await this.runMiniMaxFlow(actualRegion, provider);
            } else if (provider === 'qwen-portal') {
                await this.runQwenFlow();
            } else {
                throw new Error(`Unsupported OAuth provider type: ${provider}`);
            }
            return true;
        } catch (error) {
            if (!this.active) {
                // Flow was cancelled
                return false;
            }
            logger.error(`[DeviceOAuth] Flow error for ${provider}:`, error);
            this.emitError(error instanceof Error ? error.message : String(error));
            this.active = false;
            this.activeProvider = null;
            return false;
        }
    }

    async stopFlow(): Promise<void> {
        this.active = false;
        this.activeProvider = null;
        logger.info('[DeviceOAuth] Flow explicitly stopped');
    }

    // ─────────────────────────────────────────────────────────
    // MiniMax flow
    // ─────────────────────────────────────────────────────────

    private async runMiniMaxFlow(region: MiniMaxRegion, providerType: OAuthProviderType = 'minimax-portal'): Promise<void> {
        const provider = this.activeProvider!;

        const token: MiniMaxOAuthToken = await loginMiniMaxPortalOAuth({
            region,
            openUrl: async (url) => {
                logger.info(`[DeviceOAuth] MiniMax opening browser: ${url}`);
                shell.openExternal(url).catch((err) =>
                    logger.warn(`[DeviceOAuth] Failed to open browser:`, err)
                );
            },
            note: async (message, _title) => {
                if (!this.active) return;
                const { verificationUri, userCode } = this.parseNote(message);
                if (verificationUri && userCode) {
                    this.emitCode({ provider, verificationUri, userCode, expiresIn: 300 });
                } else {
                    logger.info(`[DeviceOAuth] MiniMax note: ${message}`);
                }
            },
            progress: {
                update: (msg) => logger.info(`[DeviceOAuth] MiniMax progress: ${msg}`),
                stop: (msg) => logger.info(`[DeviceOAuth] MiniMax progress done: ${msg ?? ''}`),
            },
        });

        if (!this.active) return;

        await this.onSuccess(providerType, {
            access: token.access,
            refresh: token.refresh,
            expires: token.expires,
            resourceUrl: token.resourceUrl,
            region,
        });
    }

    // ─────────────────────────────────────────────────────────
    // Qwen flow
    // ─────────────────────────────────────────────────────────

    private async runQwenFlow(): Promise<void> {
        const provider = this.activeProvider!;

        const token: QwenOAuthToken = await loginQwenPortalOAuth({
            openUrl: async (url) => {
                logger.info(`[DeviceOAuth] Qwen opening browser: ${url}`);
                shell.openExternal(url).catch((err) =>
                    logger.warn(`[DeviceOAuth] Failed to open browser:`, err)
                );
            },
            note: async (message, _title) => {
                if (!this.active) return;
                const { verificationUri, userCode } = this.parseNote(message);
                if (verificationUri && userCode) {
                    this.emitCode({ provider, verificationUri, userCode, expiresIn: 300 });
                } else {
                    logger.info(`[DeviceOAuth] Qwen note: ${message}`);
                }
            },
            progress: {
                update: (msg) => logger.info(`[DeviceOAuth] Qwen progress: ${msg}`),
                stop: (msg) => logger.info(`[DeviceOAuth] Qwen progress done: ${msg ?? ''}`),
            },
        });

        if (!this.active) return;

        await this.onSuccess('qwen-portal', {
            access: token.access,
            refresh: token.refresh,
            expires: token.expires,
            resourceUrl: token.resourceUrl,
        });
    }

    // ─────────────────────────────────────────────────────────
    // Success handler
    // ─────────────────────────────────────────────────────────

    private async onSuccess(providerType: OAuthProviderType, token: {
        access: string;
        refresh: string;
        expires: number;
        resourceUrl?: string;
        region?: MiniMaxRegion;
    }) {
        this.active = false;
        this.activeProvider = null;
        logger.info(`[DeviceOAuth] Successfully completed OAuth for ${providerType}`);

        // 1. Resolve base URL
        const mapping = COPAW_PROVIDER_MAPPINGS[providerType];
        if (!mapping) {
            logger.error(`[DeviceOAuth] No CoPaw mapping for provider: ${providerType}`);
            return;
        }

        let baseUrl = token.resourceUrl || mapping.defaultBaseUrl;

        // Ensure baseUrl has a protocol prefix
        if (baseUrl && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
            baseUrl = 'https://' + baseUrl;
        }

        // MiniMax: ensure base URL ends with /anthropic
        if (providerType.startsWith('minimax-portal') && baseUrl) {
            baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
        } else if (providerType === 'qwen-portal' && baseUrl) {
            // Qwen: ensure /v1 at the end
            if (!baseUrl.endsWith('/v1')) {
                baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
            }
        }

        // 2. Save token to electron-store
        try {
            await saveOAuthToken(providerType, {
                access: token.access,
                refresh: token.refresh,
                expires: token.expires,
                baseUrl,
                region: token.region,
                syncedToCoPaw: false,
            });
        } catch (err) {
            logger.warn(`[DeviceOAuth] Failed to save OAuth token to store:`, err);
        }

        // 3. Sync to CoPaw: create provider + set api_key
        let synced = false;
        try {
            await ensureCoPawProvider(mapping);
            synced = await syncTokenToCoPaw(mapping.copawProviderId, token.access, baseUrl);
        } catch (err) {
            logger.warn(`[DeviceOAuth] Failed to sync to CoPaw:`, err);
        }

        // Update sync status
        if (synced) {
            try {
                await saveOAuthToken(providerType, {
                    access: token.access,
                    refresh: token.refresh,
                    expires: token.expires,
                    baseUrl,
                    region: token.region,
                    syncedToCoPaw: true,
                });
            } catch {
                // ignore
            }
        }

        // 4. Save provider record in ClawX's own store
        const existing = await getProvider(providerType);
        const nameMap: Record<OAuthProviderType, string> = {
            'minimax-portal': 'MiniMax (Global)',
            'minimax-portal-cn': 'MiniMax (CN)',
            'qwen-portal': 'Qwen',
        };
        const providerConfig: ProviderConfig = {
            id: providerType,
            name: nameMap[providerType] || providerType,
            type: providerType,
            enabled: existing?.enabled ?? true,
            baseUrl,
            model: existing?.model || getProviderDefaultModel(providerType),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await saveProvider(providerConfig);

        // 5. Emit success
        this.emit('oauth:success', providerType);
        this.emitSuccess(providerType);
    }

    // ─────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────

    private parseNote(message: string): { verificationUri?: string; userCode?: string } {
        // Extract URL (everything between "Open " and " to")
        const urlMatch = message.match(/Open\s+(https?:\/\/\S+?)\s+to/i);
        const verificationUri = urlMatch?.[1];

        let userCode: string | undefined;

        // Method 1: extract user_code from URL query param
        if (verificationUri) {
            try {
                const parsed = new URL(verificationUri);
                const qp = parsed.searchParams.get('user_code');
                if (qp) userCode = qp;
            } catch {
                // fall through to text-based extraction
            }
        }

        // Method 2: text-based extraction
        if (!userCode) {
            const codeMatch = message.match(/enter.*?code\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})/i);
            if (codeMatch?.[1]) userCode = codeMatch[1].replace(/\.$/, '');
        }

        return { verificationUri, userCode };
    }

    private emitCode(data: {
        provider: string;
        verificationUri: string;
        userCode: string;
        expiresIn: number;
    }) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:code', data);
        }
    }

    private emitSuccess(provider: string) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:success', { provider, success: true });
        }
    }

    private emitError(message: string) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:error', { message });
        }
    }
}

export const deviceOAuthManager = new DeviceOAuthManager();
