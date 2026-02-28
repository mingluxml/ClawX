/**
 * Streaming Bubble Component
 * 
 * Displays streaming content from the AI assistant using useSyncExternalStore.
 * This component updates independently of the main Chat component, avoiding
 * the flickering caused by frequent zustand state updates.
 */
import { memo, useState } from 'react';
import { Sparkles, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { useStreamingDisplay } from './useStreamingDisplay';

export const StreamingBubble = memo(function StreamingBubble({ showThinking = false }: { showThinking?: boolean }) {
  const { content, thinking, phase } = useStreamingDisplay();

  // Don't render anything if idle
  if (phase === 'idle') {
    return null;
  }

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
        <Sparkles className={cn("h-4 w-4", phase === 'thinking' && "animate-pulse")} />
      </div>

      {/* Content */}
      <div className="flex flex-col w-full min-w-0 max-w-[80%] space-y-2 items-start">
        {/* Thinking block */}
        {showThinking && thinking && (
          <ThinkingBlock content={thinking} isStreaming={true} />
        )}

        {/* Main content */}
        {phase === 'thinking' && !content.trim() ? (
          <ThinkingIndicator />
        ) : (
          <StreamingContent content={content} />
        )}
      </div>
    </div>
  );
});

function ThinkingIndicator() {
  return (
    <div className="bg-muted rounded-2xl px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span>思考中...</span>
      </div>
    </div>
  );
}

function ThinkingBlock({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="w-full rounded-xl border border-border/60 bg-background overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-4 py-3 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Sparkles className={cn("h-4 w-4 text-purple-500", isStreaming && "animate-pulse")} />
        <span className="text-sm font-medium">Thinking</span>
        {isStreaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-auto mr-1" />}
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" /> : <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-border/40">
          <div className="prose prose-sm dark:prose-invert max-w-none pt-3 text-muted-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

const StreamingContent = memo(function StreamingContent({ content }: { content: string }) {
  if (!content.trim()) {
    return <ThinkingIndicator />;
  }

  return (
    <div className="relative rounded-2xl px-4 py-3 w-full bg-muted">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const isInline = !match && !className;
              if (isInline) {
                return (
                  <code className="bg-background/50 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                    {children}
                  </code>
                );
              }
              return (
                <pre className="bg-background/50 rounded-lg p-4 overflow-x-auto">
                  <code className={cn('text-sm font-mono', className)} {...props}>
                    {children}
                  </code>
                </pre>
              );
            },
            a({ href, children }) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
        {/* Blinking cursor */}
        <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse ml-0.5 align-middle" />
      </div>
    </div>
  );
});

export default StreamingBubble;
