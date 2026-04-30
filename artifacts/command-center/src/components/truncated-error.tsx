import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

interface TruncatedErrorProps {
  message: string;
  /** Show the full message inline if it is at most this long (no truncation). */
  inlineThreshold?: number;
}

export function TruncatedError({
  message,
  inlineThreshold = 240,
}: TruncatedErrorProps) {
  const [open, setOpen] = useState(false);

  const text = message ?? "";
  const totalLen = text.length;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const hasMoreLines = text.includes("\n");
  const isShort = !hasMoreLines && totalLen <= inlineThreshold;

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
