import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Optional context the calling page can attach so that the *clipboard*
 * payload — and only the clipboard payload — gets a small header
 * identifying which upload the error belongs to. The on-screen
 * rendering is unchanged regardless of whether this is supplied.
 *
 * Each field is independently optional. When `copyContext` is omitted
 * entirely, or when none of its fields are populated, the clipboard
 * gets the raw `message` with no header (so the component still works
 * unchanged in callers that don't have this info).
 */
export interface CopyContext {
  /** Source file name, e.g. `q3-suppliers.csv`. */
  fileName?: string;
  /** Entity / dataset key, e.g. `suppliers`. */
  entity?: string;
  /**
   * When the error occurred. Pass a `Date` to have it formatted as
   * `YYYY-MM-DD HH:MM UTC`, or a pre-formatted string to use verbatim.
   */
  timestamp?: Date | string;
}

interface TruncatedErrorProps {
  message: string;
  /** Show the full message inline if it is at most this long (no truncation). */
  inlineThreshold?: number;
  /**
   * Optional metadata about the failed action. When provided, a small
   * header is prepended to the clipboard payload so support engineers
   * receiving the pasted error don't have to ask "which upload was
   * this?". See {@link CopyContext}.
   */
  copyContext?: CopyContext;
}

function formatCopyTimestamp(t: Date | string): string {
  if (typeof t === "string") return t;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`
  );
}

export function buildCopyPayload(message: string, ctx?: CopyContext): string {
  if (!ctx) return message;
  const headerLines: string[] = [];
  if (ctx.fileName) headerLines.push(`# File: ${ctx.fileName}`);
  if (ctx.entity) headerLines.push(`# Entity: ${ctx.entity}`);
  if (ctx.timestamp) {
    headerLines.push(`# When: ${formatCopyTimestamp(ctx.timestamp)}`);
  }
  if (headerLines.length === 0) return message;
  return `# Failed upload\n${headerLines.join("\n")}\n\n${message}`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function TruncatedError({
  message,
  inlineThreshold = 240,
  copyContext,
}: TruncatedErrorProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const text = message ?? "";
  const totalLen = text.length;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const hasMoreLines = text.includes("\n");
  const isShort = !hasMoreLines && totalLen <= inlineThreshold;

  const handleCopy = async () => {
    const payload = buildCopyPayload(text, copyContext);
    const ok = await copyTextToClipboard(payload);
    if (ok) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      toast({
        title: "Error copied",
        description: "The full error message is on your clipboard.",
      });
    } else {
      toast({
        variant: "destructive",
        title: "Couldn't copy",
        description: "Your browser blocked clipboard access. Select the text manually.",
      });
    }
  };

  if (isShort) {
    return (
      <pre
        data-testid="text-error-message"
        className="font-mono text-xs whitespace-pre-wrap break-words"
      >
        {text}
      </pre>
    );
  }

  const summary =
    firstLine.length > inlineThreshold
      ? `${firstLine.slice(0, inlineThreshold).trimEnd()}…`
      : firstLine;

  return (
    <div className="space-y-2">
      <pre
        data-testid="text-error-summary"
        className="font-mono text-xs whitespace-pre-wrap break-words"
      >
        {summary}
      </pre>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="text-error-length">
          {totalLen.toLocaleString()} characters total
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setOpen((v) => !v)}
          data-testid="button-toggle-error-details"
          aria-expanded={open}
        >
          {open ? (
            <>
              <ChevronUp className="w-3 h-3 mr-1" />
              Hide details
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3 mr-1" />
              Show details
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleCopy}
          data-testid="button-copy-error"
          aria-label="Copy error message"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 mr-1" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3 mr-1" />
              Copy
            </>
          )}
        </Button>
      </div>
      {open && (
        <pre
          data-testid="text-error-details"
          className="font-mono text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto rounded border border-destructive/30 bg-destructive/5 p-2"
        >
          {text}
        </pre>
      )}
    </div>
  );
}
