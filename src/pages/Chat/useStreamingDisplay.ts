/**
 * Streaming Display Hook
 * 
 * Uses useSyncExternalStore to subscribe to streaming content updates
 * without causing the parent Chat component to re-render.
 * 
 * This decouples the streaming display from zustand, avoiding the
 * performance issues caused by frequent state updates during SSE.
 */
import { useSyncExternalStore } from 'react';

// Module-level streaming state (not in React state to avoid re-renders)
let _streamingContent: string = '';
let _streamingThinking: string = '';
let _streamingPhase: 'idle' | 'thinking' | 'streaming' = 'idle';
let _listeners: Set<() => void> = new Set();

// Cached snapshot object - only recreate when content actually changes
let _snapshot: { content: string; thinking: string; phase: 'idle' | 'thinking' | 'streaming' } = {
  content: '',
  thinking: '',
  phase: 'idle',
};

// Notify all subscribers of a change
function notifyListeners() {
  // Update cached snapshot
  _snapshot = {
    content: _streamingContent,
    thinking: _streamingThinking,
    phase: _streamingPhase,
  };
  _listeners.forEach(listener => listener());
}

// Public API to update streaming state (called from chat store)
export function updateStreamingDisplay(content: string, thinking: string, phase: 'idle' | 'thinking' | 'streaming') {
  const changed = _streamingContent !== content || _streamingThinking !== thinking || _streamingPhase !== phase;
  if (changed) {
    _streamingContent = content;
    _streamingThinking = thinking;
    _streamingPhase = phase;
    notifyListeners();
  }
}

export function resetStreamingDisplay() {
  if (_streamingContent !== '' || _streamingThinking !== '' || _streamingPhase !== 'idle') {
    _streamingContent = '';
    _streamingThinking = '';
    _streamingPhase = 'idle';
    notifyListeners();
  }
}

export function setStreamingPhase(phase: 'idle' | 'thinking' | 'streaming') {
  if (_streamingPhase !== phase) {
    _streamingPhase = phase;
    notifyListeners();
  }
}

// Subscribe function for useSyncExternalStore
function subscribe(callback: () => void) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

// Get snapshot - returns cached object to prevent infinite re-renders
function getSnapshot() {
  return _snapshot;
}

// Hook to subscribe to streaming state
export function useStreamingDisplay() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Get current state without subscribing (for one-time reads)
export function getStreamingState() {
  return _snapshot;
}
