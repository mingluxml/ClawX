/**
 * OAuth Token Store
 * Manages OAuth token persistence via electron-store
 */
import type { OAuthProviderType } from './device-oauth';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oauthStore: any = null;

export interface OAuthTokenEntry {
  provider: OAuthProviderType;
  access: string;
  refresh: string;
  expires: number;       // ms timestamp
  baseUrl: string;
  region?: string;       // MiniMax region
  syncedToCoPaw: boolean;
  updatedAt: string;     // ISO date
}

async function getStore() {
  if (!oauthStore) {
    const Store = (await import('electron-store')).default;
    oauthStore = new Store({
      name: 'clawx-oauth-tokens',
      defaults: {
        tokens: {} as Record<string, OAuthTokenEntry>,
      },
    });
  }
  return oauthStore;
}

/**
 * Save an OAuth token entry
 */
export async function saveOAuthToken(provider: OAuthProviderType, token: Omit<OAuthTokenEntry, 'provider' | 'updatedAt'>): Promise<void> {
  const s = await getStore();
  const tokens = (s.get('tokens') || {}) as Record<string, OAuthTokenEntry>;
  tokens[provider] = {
    ...token,
    provider,
    updatedAt: new Date().toISOString(),
  };
  s.set('tokens', tokens);
}

/**
 * Get an OAuth token entry
 */
export async function getOAuthToken(provider: OAuthProviderType): Promise<OAuthTokenEntry | null> {
  const s = await getStore();
  const tokens = (s.get('tokens') || {}) as Record<string, OAuthTokenEntry>;
  return tokens[provider] || null;
}

/**
 * Remove an OAuth token entry
 */
export async function removeOAuthToken(provider: OAuthProviderType): Promise<void> {
  const s = await getStore();
  const tokens = (s.get('tokens') || {}) as Record<string, OAuthTokenEntry>;
  delete tokens[provider];
  s.set('tokens', tokens);
}

/**
 * Check if a token is expired
 */
export async function isTokenExpired(provider: OAuthProviderType): Promise<boolean> {
  const token = await getOAuthToken(provider);
  if (!token) return true;
  return token.expires < Date.now();
}

/**
 * Get all stored OAuth tokens
 */
export async function getAllOAuthTokens(): Promise<OAuthTokenEntry[]> {
  const s = await getStore();
  const tokens = (s.get('tokens') || {}) as Record<string, OAuthTokenEntry>;
  return Object.values(tokens);
}
