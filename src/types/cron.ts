/**
 * Cron Job Type Definitions
 * Types for scheduled tasks
 *
 * Note: The frontend uses a simplified internal format.
 * Conversion to/from CoPaw API format happens in copaw-backend.ts.
 */

import { ChannelType } from './channel';

/**
 * Cron job target (where to send the result)
 */
export interface CronJobTarget {
  channelType: ChannelType;
  channelId: string;
  channelName: string;
}

/**
 * Cron job last run info
 */
export interface CronJobLastRun {
  time: string;
  success: boolean;
  error?: string;
  duration?: number;
}

/**
 * Gateway CronSchedule object format
 */
export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

/**
 * Cron job data structure - internal UI format.
 * CoPaw API uses a different format; conversion is in copaw-backend.ts.
 */
export interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRun?: CronJobLastRun;
  nextRun?: string;
  target?: CronJobTarget;
  /** Target channel for task execution (e.g., 'console', 'telegram') */
  channel?: string;
  /** Target session ID for task execution */
  sessionId?: string;
}

/**
 * Input for creating a cron job from the UI.
 * UI-created tasks push results to the ClawX chat page.
 */
export interface CronJobCreateInput {
  name: string;
  message: string;
  schedule: string;
  enabled?: boolean;
  /** Target channel (defaults to 'console') */
  channel?: string;
  /** Target session ID */
  sessionId?: string;
}

/**
 * Input for updating a cron job
 */
export interface CronJobUpdateInput {
  name?: string;
  message?: string;
  schedule?: string;
  enabled?: boolean;
  /** Target channel */
  channel?: string;
  /** Target session ID */
  sessionId?: string;
}

/**
 * Schedule type for UI picker
 */
export type ScheduleType = 'daily' | 'weekly' | 'monthly' | 'interval' | 'custom';
