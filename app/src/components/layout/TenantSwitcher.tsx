import type { ReactElement } from "react";
import { useMyMemberships } from "@/hooks/use-my-memberships";
import { useSwitchTenant } from "@/hooks/use-switch-tenant";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";

/**
 * Header dropdown for switching the active tenant. Renders nothing for users
 * with a single membership — the trigger only appears when there is somewhere
 * to switch to.
 */
export function TenantSwitcher(): ReactElement | null {
  const { data: memberships } = useMyMemberships();
  const switchTenant = useSwitchTenant();
  if (!memberships || memberships.length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] hover:text-[color:var(--ink)]">
        Trocar tenant <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.tenantId}
            onSelect={() => {
              switchTenant.mutate({ tenantId: m.tenantId });
            }}
          >
            {m.tenantName}{" "}
            <span className="text-[color:var(--ink-mute)] ml-2 text-xs">({m.role})</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
