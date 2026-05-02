import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Building2, Loader2, Search } from "lucide-react";
import {
  useListSuppliers,
  type ListSuppliersParams,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * Header-mounted typeahead so a buyer who knows a supplier name —
 * but not where it sits in the spend ranking — can jump straight to
 * the Supplier 360 page from anywhere in the app. Uses the existing
 * `GET /suppliers?search=` endpoint (server-side ilike on name) and
 * disables cmdk's client-side filter so we don't hide rows the
 * server already deemed a match. Only mounted for signed-in users
 * because the underlying request is tenant-scoped.
 */
export function GlobalSupplierSearch() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const params = useMemo<ListSuppliersParams | undefined>(() => {
    if (!trimmed) return undefined;
    return { search: trimmed, limit: 10 };
  }, [trimmed]);

  const { data, isFetching } = useListSuppliers(params, {
    query: {
      // Only fire while the popover is open AND the operator has
      // actually typed something — keeps the header weightless on
      // every page that doesn't need it.
      enabled: open && !!params,
      queryKey: ["global-supplier-search", trimmed],
    },
  });

  const items = data?.items ?? [];

  const handleSelect = (id: string) => {
    setOpen(false);
    setQuery("");
    navigate(`/suppliers/${id}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="btn-global-supplier-search"
          className="hidden md:flex items-center gap-2 px-3 h-8 rounded-md border border-input bg-background text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition w-56"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 text-left">Find supplier…</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        data-testid="popover-global-supplier-search"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search suppliers by name…"
            value={query}
            onValueChange={setQuery}
            data-testid="input-global-supplier-search"
          />
          <CommandList>
            {!trimmed ? (
              <div
                className="py-6 text-center text-xs text-muted-foreground"
                data-testid="text-global-search-prompt"
              >
                Start typing a supplier name.
              </div>
            ) : isFetching && items.length === 0 ? (
              <div
                className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
                data-testid="text-global-search-loading"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                Searching…
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty data-testid="text-global-search-empty">
                No suppliers match &ldquo;{trimmed}&rdquo;.
              </CommandEmpty>
            ) : (
              <CommandGroup heading="Suppliers">
                {items.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={s.id}
                    onSelect={() => handleSelect(s.id)}
                    data-testid={`global-search-result-${s.id}`}
                  >
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span className="font-medium truncate">{s.name}</span>
                    {s.countryCode ? (
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {s.countryCode}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
