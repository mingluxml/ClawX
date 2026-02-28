/**
 * Chat Message Component
 * Renders user / assistant / system / toolresult messages
 * with markdown, thinking sections, images, and tool cards.
 */
import { useState, useCallback, useEffect, memo } from 'react';
import { User, Sparkles, Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, X, FolderOpen, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RawMessage, AttachedFileMeta } from '@/stores/chat';
import { extractText, extractThinking, extractImages, extractToolUse, formatTimestamp } from './message-utils';

interface ChatMessageProps {
  message: RawMessage;
  showThinking: boolean;
  isStreaming?: boolean;
  streamingTools?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}

interface ExtractedImage { url?: string; data?: string; mimeType: string; }

/** Resolve an ExtractedImage to a displayable src string, or null if not possible. */
function imageSrc(img: ExtractedImage): string | null {
  if (img.url) return img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  showThinking,
  isStreaming = false,
  streamingTools = [],
}: ChatMessageProps) {
  const isUser = message.role === 'user';
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  const isToolResult = role === 'toolresult' || role === 'tool_result';
  const text = extractText(message);
  const hasText = text.trim().length > 0;
  const thinking = extractThinking(message);
  const images = extractImages(message);
  const tools = extractToolUse(message);
  const visibleThinking = showThinking ? thinking : null;
  const visibleTools = tools;

  const attachedFiles = message._attachedFiles || [];
  const [lightboxImg, setLightboxImg] = useState<{ src: string; fileName: string; filePath?: string; base64?: string; mimeType?: string } | null>(null);

  // Never render tool result messages in chat UI
  if (isToolResult) return null;

  const hasStreamingToolStatus = isStreaming && streamingTools.length > 0;
  if (!hasText && !visibleThinking && images.length === 0 && visibleTools.length === 0 && attachedFiles.length === 0 && !hasStreamingToolStatus) return null;

  return (
    <div
      className={cn(
        'flex gap-3 group',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white',
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </div>

      {/* Content */}
      <div
        className={cn(
          'flex flex-col w-full min-w-0 max-w-[80%] space-y-2',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        {isStreaming && !isUser && streamingTools.length > 0 && (
          <ToolStatusBar tools={streamingTools} />
        )}

        {/* Thinking section */}
        {visibleThinking && (
          <ThinkingBlock content={visibleThinking} />
        )}

        {/* Tool use cards */}
        {visibleTools.length > 0 && (
          <div className="space-y-2">
            {visibleTools.map((tool, i) => (
              <ToolCard key={tool.id || i} name={tool.name} input={tool.input} output={tool.output} />
            ))}
          </div>
        )}

        {/* Images — rendered ABOVE text bubble for user messages */}
        {/* Images from content blocks (Gateway session data / channel push photos) */}
        {isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImageThumbnail
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — images above text for user, file cards below */}
        {isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              // Skip image attachments if we already have images from content blocks
              if (isImage && images.length > 0) return null;
              if (isImage) {
                return file.preview ? (
                  <ImageThumbnail
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                  />
                ) : (
                  <div
                    key={`local-${i}`}
                    className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground"
                  >
                    <File className="h-8 w-8" />
                  </div>
                );
              }
              // Non-image files → file card
              return <FileCard key={`local-${i}`} file={file} />;
            })}
          </div>
        )}

        {/* Main text bubble */}
        {hasText && (
          <MessageBubble
            text={text}
            isUser={isUser}
            isStreaming={isStreaming}
          />
        )}

        {/* Images from content blocks — assistant messages (below text) */}
        {!isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImagePreviewCard
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — assistant messages (below text) */}
        {!isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              if (isImage && images.length > 0) return null;
              if (isImage && file.preview) {
                return (
                  <ImagePreviewCard
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                  />
                );
              }
              if (isImage && !file.preview) {
                return (
                  <div key={`local-${i}`} className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground">
                    <File className="h-8 w-8" />
                  </div>
                );
              }
              return <FileCard key={`local-${i}`} file={file} />;
            })}
          </div>
        )}

        {/* Hover row for user messages — timestamp only */}
        {isUser && message.timestamp && (
          <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none">
            {formatTimestamp(message.timestamp)}
          </span>
        )}

        {/* Hover row for assistant messages — only when there is real text content */}
        {!isUser && hasText && (
          <AssistantHoverBar text={text} timestamp={message.timestamp} />
        )}
      </div>

      {/* Image lightbox portal */}
      {lightboxImg && (
        <ImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          base64={lightboxImg.base64}
          mimeType={lightboxImg.mimeType}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </div>
  );
});

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function ToolStatusBar({
  tools,
}: {
  tools: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}) {
  return (
    <div className="w-full space-y-1">
      {tools.map((tool) => {
        const duration = formatDuration(tool.durationMs);
        const isRunning = tool.status === 'running';
        const isError = tool.status === 'error';
        return (
          <div
            key={tool.toolCallId || tool.id || tool.name}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
              isRunning && 'border-primary/30 bg-primary/5 text-foreground',
              !isRunning && !isError && 'border-border/50 bg-muted/20 text-muted-foreground',
              isError && 'border-destructive/30 bg-destructive/5 text-destructive',
            )}
          >
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
            {!isRunning && !isError && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
            {isError && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <Wrench className="h-3 w-3 shrink-0 opacity-60" />
            <span className="font-mono text-[12px] font-medium">{tool.name}</span>
            {duration && <span className="text-[11px] opacity-60">{duration}</span>}
            {tool.summary && (
              <span className="truncate text-[11px] opacity-70">{tool.summary}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Assistant hover bar (timestamp + copy, shown on group hover) ─

function AssistantHoverBar({ text, timestamp }: { text: string; timestamp?: number }) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <div className="flex items-center justify-between w-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none px-1">
      <span className="text-xs text-muted-foreground">
        {timestamp ? formatTimestamp(timestamp) : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={copyContent}
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

// ── Message Bubble ──────────────────────────────────────────────

function MessageBubble({
  text,
  isUser,
  isStreaming,
}: {
  text: string;
  isUser: boolean;
  isStreaming: boolean;
}) {
  return (
    <div
      className={cn(
        'relative rounded-2xl px-4 py-3',
        !isUser && 'w-full',
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted',
      )}
    >
      {isUser ? (
        <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
      ) : (
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
            {text}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse ml-0.5" />
          )}
        </div>
      )}

    </div>
  );
}

// ── Thinking Block ──────────────────────────────────────────────

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

// ── File Card (for user-uploaded non-image files) ───────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

function FileCard({ file }: { file: AttachedFileMeta }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 bg-muted/30 max-w-[220px]">
      <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 overflow-hidden">
        <p className="text-xs font-medium truncate">{file.fileName}</p>
        <p className="text-[10px] text-muted-foreground">
          {file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File'}
        </p>
      </div>
    </div>
  );
}

// ── Image Thumbnail (user bubble — square crop with zoom hint) ──

function ImageThumbnail({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onPreview,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onPreview: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative w-36 h-36 rounded-xl border overflow-hidden bg-muted group/img cursor-zoom-in"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="w-full h-full object-cover" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/25 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

// ── Image Preview Card (assistant bubble — natural size with overlay actions) ──

function ImagePreviewCard({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onPreview,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onPreview: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative max-w-xs rounded-lg border overflow-hidden group/img cursor-zoom-in"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="block w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

// ── Image Lightbox ───────────────────────────────────────────────

function ImageLightbox({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onClose,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onClose: () => void;
}) {
  void src; void base64; void mimeType; void fileName;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleShowInFolder = useCallback(() => {
    if (filePath) {
      window.electron.ipcRenderer.invoke('shell:showItemInFolder', filePath);
    }
  }, [filePath]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Image + buttons stacked */}
      <div
        className="flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={fileName}
          className="max-w-[90vw] max-h-[85vh] rounded-lg shadow-2xl object-contain"
        />

        {/* Action buttons below image */}
        <div className="flex items-center gap-2">
          {filePath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
              onClick={handleShowInFolder}
              title="在文件夹中显示"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Tool Card ───────────────────────────────────────────────────

function ToolCard({ name, input, output }: { name: string; input: unknown; output?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const inputStr = input != null 
    ? (typeof input === 'string' ? input : JSON.stringify(input, null, 2))
    : '{}';
  const outputStr = output != null
    ? (typeof output === 'string' ? output : JSON.stringify(output, null, 2))
    : null;

  const copyInput = useCallback(() => {
    navigator.clipboard.writeText(inputStr);
    setCopiedInput(true);
    setTimeout(() => setCopiedInput(false), 2000);
  }, [inputStr]);

  const copyOutput = useCallback(() => {
    if (outputStr) {
      navigator.clipboard.writeText(outputStr);
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 2000);
    }
  }, [outputStr]);

  return (
    <div className="w-full rounded-xl border border-border/60 bg-background overflow-hidden">
      {/* Header */}
      <button
        className="flex items-center gap-2 w-full px-4 py-3 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-mono text-sm font-medium">{name}</span>
        {expanded ? <ChevronDown className="h-4 w-4 ml-auto text-muted-foreground" /> : <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border/40">
          {/* Input Section */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Input</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={copyInput}
              >
                {copiedInput ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
              </Button>
            </div>
            <div className="bg-muted/50 rounded-lg overflow-hidden">
              <pre className="p-3 text-xs font-mono overflow-x-auto text-muted-foreground">
                <code>{inputStr}</code>
              </pre>
            </div>
          </div>

          {/* Output Section */}
          {outputStr && (
            <div className="px-4 py-3 border-t border-border/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-foreground">Output</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={copyOutput}
                >
                  {copiedOutput ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                </Button>
              </div>
              <div className="bg-muted/50 rounded-lg overflow-hidden">
                <SyntaxHighlightedCode code={outputStr} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Syntax Highlighted Code (simple JSON highlighting) ──────────

function SyntaxHighlightedCode({ code }: { code: string }) {
  // Simple JSON syntax highlighting
  const highlightJSON = (text: string) => {
    // Try to parse and re-stringify for consistent formatting
    try {
      const parsed = JSON.parse(text);
      text = JSON.stringify(parsed, null, 2);
    } catch {
      // If not valid JSON, use as-is
    }

    const lines = text.split('\n');
    return lines.map((line, lineIdx) => {
      const parts: React.ReactNode[] = [];
      let remaining = line;
      let keyIdx = 0;

      // Highlight strings (keys and values)
      const stringRegex = /"([^"\\]|\\.)*"/g;
      let match;
      let lastIndex = 0;

      while ((match = stringRegex.exec(remaining)) !== null) {
        // Add text before the match
        if (match.index > lastIndex) {
          parts.push(
            <span key={`${lineIdx}-${keyIdx++}`} className="text-muted-foreground">
              {remaining.slice(lastIndex, match.index)}
            </span>
          );
        }

        // Determine if this is a key (followed by :) or a value
        const afterMatch = remaining.slice(match.index + match[0].length);
        const isKey = afterMatch.trimStart().startsWith(':');

        parts.push(
          <span
            key={`${lineIdx}-${keyIdx++}`}
            className={isKey ? 'text-foreground' : 'text-rose-500 dark:text-rose-400'}
          >
            {match[0]}
          </span>
        );

        lastIndex = match.index + match[0].length;
      }

      // Add remaining text
      if (lastIndex < remaining.length) {
        // Highlight numbers, booleans, null
        const rest = remaining.slice(lastIndex);
        const highlighted = rest
          .replace(/\b(true|false|null)\b/g, '<bool>$1</bool>')
          .replace(/\b(\d+\.?\d*)\b/g, '<num>$1</num>');
        
        if (highlighted.includes('<bool>') || highlighted.includes('<num>')) {
          const boolParts = highlighted.split(/(<bool>.*?<\/bool>|<num>.*?<\/num>)/);
          for (const part of boolParts) {
            if (part.startsWith('<bool>')) {
              parts.push(
                <span key={`${lineIdx}-${keyIdx++}`} className="text-blue-500 dark:text-blue-400">
                  {part.replace(/<\/?bool>/g, '')}
                </span>
              );
            } else if (part.startsWith('<num>')) {
              parts.push(
                <span key={`${lineIdx}-${keyIdx++}`} className="text-amber-600 dark:text-amber-400">
                  {part.replace(/<\/?num>/g, '')}
                </span>
              );
            } else {
              parts.push(
                <span key={`${lineIdx}-${keyIdx++}`} className="text-muted-foreground">
                  {part}
                </span>
              );
            }
          }
        } else {
          parts.push(
            <span key={`${lineIdx}-rest-${keyIdx}`} className="text-muted-foreground">
              {rest}
            </span>
          );
        }
      }

      return (
        <div key={lineIdx} className="flex">
          <span className="w-8 shrink-0 text-muted-foreground/50 select-none text-right pr-3">
            {lineIdx + 1}
          </span>
          <span>{parts.length > 0 ? parts : line}</span>
        </div>
      );
    });
  };

  return (
    <pre className="p-3 text-xs font-mono overflow-x-auto">
      <code>{highlightJSON(code)}</code>
    </pre>
  );
}
