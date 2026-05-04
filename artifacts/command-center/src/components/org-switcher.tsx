import { useQueryClient } from "@tanstack/react-query";
import { useListOrgs } from "@workspace/api-client-react";
import { Check, ChevronsUpDown, Building } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: orgs } = useListOrgs();
  const [activeOrgId, setActiveOrgId] = useState<string>("");

  useEffect(() => {
    setActiveOrgId(localStorage.getItem("activeOrgId") ?? "");
  }, []);

  const activeOrg = orgs?.find((org) => org.id === activeOrgId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Switch organization"
          className="w-full justify-between"
        >
          <Building className="mr-2 h-4 w-4 opacity-50" />
          {activeOrg ? activeOrg.name : "Select organization..."}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command>
          <CommandInput placeholder="Search organization..." />
          <CommandList>
            <CommandEmpty>No organization found.</CommandEmpty>
            <CommandGroup>
              {orgs?.map((org) => (
                <CommandItem
                  key={org.id}
                  value={org.id}
                  onSelect={(currentValue) => {
                    if (currentValue !== activeOrgId) {
                      localStorage.setItem("activeOrgId", currentValue);
                      setActiveOrgId(currentValue);
                      queryClient.clear();
                      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
                      window.location.href = `${base}/`;
                    }
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      activeOrgId === org.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {org.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
