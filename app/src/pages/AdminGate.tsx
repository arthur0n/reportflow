import { type ReactElement, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { useMe } from "@/hooks/use-me";

const ADMIN_ROLES = ["admin", "platform_admin"];

/**
 * Client-side gate for admin routes. Mirrors `adminProcedure` — the server is
 * the authority, this only spares the user a wall of FORBIDDEN toasts.
 * Ported from lexflow's AdminGate; role now comes from `users.role` scoped to
 * the caller's Clerk org.
 */
export function AdminGate({ children }: { children: ReactNode }): ReactElement {
  const me = useMe();

  if (me.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[color:var(--ink-mute)]">
        Carregando…
      </div>
    );
  }

  if (me.data === undefined || !ADMIN_ROLES.includes(me.data.role)) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
        <Shield className="h-10 w-10 text-[color:var(--ink-mute)]" strokeWidth={1.5} />
        <p className="text-lg font-semibold text-[color:var(--ink)]">Acesso restrito</p>
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Esta página requer permissão de administrador.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
