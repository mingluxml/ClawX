/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import type { Skill, MarketplaceSkill } from '../types/skill';

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type GatewayRpcResponse<T> = {
  success: boolean;
  result?: T;
  error?: string;
};

type ImportResult = {
  success: boolean;
  skillName?: string;
  skillPath?: string;
  error?: string;
  errorCode?: string;
};

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  importingFromUrl: boolean;
  importError: string | null;
  error: string | null;

  // Actions
  fetchSkills: () => Promise<void>;
  searchSkills: (query: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  importSkillFromUrl: (url: string) => Promise<ImportResult>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  searchResults: [],
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  importingFromUrl: false,
  importError: null,
  error: null,

  fetchSkills: async () => {
    // Only show loading state if we have no skills yet (initial load)
    if (get().skills.length === 0) {
      set({ loading: true, error: null });
    }
    try {
      // Fetch from Backend (running skills)
      const gatewayResult = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'skills.status'
      ) as GatewayRpcResponse<GatewaySkillsStatusResult>;

      // Fetch configurations directly from Electron (since Gateway doesn't return them)
      const configResult = await window.electron.ipcRenderer.invoke(
        'skill:getAllConfigs'
      ) as Record<string, { apiKey?: string; env?: Record<string, string> }>;

      let combinedSkills: Skill[] = [];
      const currentSkills = get().skills;

      // Map gateway skills info
      if (gatewayResult.success && gatewayResult.result?.skills) {
        combinedSkills = gatewayResult.result.skills.map((s: GatewaySkillStatus) => {
          // Merge with direct config if available
          const directConfig = configResult[s.skillKey] || {};

          return {
            id: s.skillKey,
            slug: s.slug || s.skillKey,
            name: s.name || s.skillKey,
            description: s.description || '',
            enabled: !s.disabled,
            icon: s.emoji || '📦',
            version: s.version || '1.0.0',
            author: s.author,
            config: {
              ...(s.config || {}),
              ...directConfig,
            },
            isCore: s.bundled && s.always,
            isBundled: s.bundled,
          };
        });
      } else if (currentSkills.length > 0) {
        // ... if gateway down ...
        combinedSkills = [...currentSkills];
      }

      set({ skills: combinedSkills, loading: false });
    } catch (error) {
      console.error('Failed to fetch skills:', error);
      let errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('Timeout')) {
        errorMsg = 'timeoutError';
      } else if (errorMsg.toLowerCase().includes('rate limit')) {
        errorMsg = 'rateLimitError';
      }
      set({ loading: false, error: errorMsg });
    }
  },

  searchSkills: async (_query: string) => {
    set({ searching: true, searchError: null });
    try {
      // Skill marketplace search is not yet implemented for CoPaw backend
      // TODO: Implement skill marketplace integration with CoPaw
      set({ searchResults: [], searching: false });
    } catch (error) {
      set({ searchError: String(error), searching: false });
    }
  },

  installSkill: async (slug: string, _version?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      // Skill installation via marketplace is not yet implemented for CoPaw backend
      // TODO: Implement skill installation with CoPaw
      throw new Error('Skill marketplace installation is not yet available. Please install skills manually.');
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      // Skill uninstallation via marketplace is not yet implemented for CoPaw backend
      // TODO: Implement skill uninstallation with CoPaw
      throw new Error('Skill marketplace uninstallation is not yet available. Please manage skills manually.');
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  enableSkill: async (skillId) => {
    const { updateSkill } = get();

    try {
      const result = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'skills.update',
        { skillKey: skillId, enabled: true }
      ) as GatewayRpcResponse<unknown>;

      if (result.success) {
        updateSkill(skillId, { enabled: true });
      } else {
        throw new Error(result.error || 'Failed to enable skill');
      }
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }

    try {
      const result = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'skills.update',
        { skillKey: skillId, enabled: false }
      ) as GatewayRpcResponse<unknown>;

      if (result.success) {
        updateSkill(skillId, { enabled: false });
      } else {
        throw new Error(result.error || 'Failed to disable skill');
      }
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  importSkillFromUrl: async (url: string) => {
    set({ importingFromUrl: true, importError: null });
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'skill:importFromUrl',
        url
      ) as ImportResult;

      if (result.success) {
        // Wait for gateway restart then refresh skills
        setTimeout(() => {
          void get().fetchSkills();
        }, 3000);
      }

      set({ importingFromUrl: false });
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      set({ importingFromUrl: false, importError: errorMsg });
      return { success: false, error: errorMsg };
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },
}));
