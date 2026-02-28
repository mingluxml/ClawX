/**
 * Cron State Store
 * Manages scheduled task state
 */
import { create } from 'zustand';
import type { CronJob, CronJobCreateInput, CronJobUpdateInput } from '../types/cron';

interface CronState {
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
  
  // Actions
  fetchJobs: () => Promise<void>;
  createJob: (input: CronJobCreateInput) => Promise<CronJob>;
  updateJob: (id: string, input: CronJobUpdateInput) => Promise<CronJob>;
  deleteJob: (id: string) => Promise<void>;
  toggleJob: (id: string, enabled: boolean) => Promise<void>;
  triggerJob: (id: string) => Promise<void>;
  setJobs: (jobs: CronJob[]) => void;
}

export const useCronStore = create<CronState>((set) => ({
  jobs: [],
  loading: false,
  error: null,
  
  fetchJobs: async () => {
    set({ loading: true, error: null });
    
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:list') as {
        success: boolean;
        jobs?: CronJob[];
        error?: string;
      };
      set({ jobs: result.success && Array.isArray(result.jobs) ? result.jobs : [], loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },
  
  createJob: async (input) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:create', input) as {
        success: boolean;
        job?: CronJob;
        error?: string;
      };
      if (!result.success || !result.job) {
        throw new Error(result.error || 'Failed to create cron job');
      }
      set((state) => ({ jobs: [...state.jobs, result.job!] }));
      return result.job;
    } catch (error) {
      console.error('Failed to create cron job:', error);
      throw error;
    }
  },
  
  updateJob: async (id, input) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:update', id, input) as {
        success: boolean;
        job?: CronJob;
        error?: string;
      };
      if (!result.success || !result.job) {
        throw new Error(result.error || 'Failed to update cron job');
      }
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === id ? result.job! : job
        ),
      }));
      return result.job;
    } catch (error) {
      console.error('Failed to update cron job:', error);
      throw error;
    }
  },

  getJob: async (id: string) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:get', id) as {
        success: boolean;
        job?: CronJob;
        error?: string;
      };
      if (!result.success || !result.job) {
        throw new Error(result.error || 'Failed to get cron job');
      }
      return result.job;
    } catch (error) {
      console.error('Failed to get cron job:', error);
      throw error;
    }
  },
  
  deleteJob: async (id) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:delete', id) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete cron job');
      }
      set((state) => ({
        jobs: state.jobs.filter((job) => job.id !== id),
      }));
    } catch (error) {
      console.error('Failed to delete cron job:', error);
      throw error;
    }
  },
  
  toggleJob: async (id, enabled) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:toggle', id, enabled) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        throw new Error(result.error || 'Failed to toggle cron job');
      }
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === id ? { ...job, enabled } : job
        ),
      }));
    } catch (error) {
      console.error('Failed to toggle cron job:', error);
      throw error;
    }
  },
  
  triggerJob: async (id) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('cron:trigger', id) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        throw new Error(result.error || 'Failed to trigger cron job');
      }
      // Refresh jobs after trigger to update lastRun/nextRun state
      try {
        const refreshResult = await window.electron.ipcRenderer.invoke('cron:list') as {
          success: boolean;
          jobs?: CronJob[];
        };
        set({ jobs: refreshResult.success && Array.isArray(refreshResult.jobs) ? refreshResult.jobs : [] });
      } catch {
        // Ignore refresh error
      }
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      throw error;
    }
  },
  
  setJobs: (jobs) => set({ jobs }),
}));
