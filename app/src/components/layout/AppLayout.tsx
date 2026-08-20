import { useState, type ReactElement, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { UserMenu } from "@/auth";
import { ChevronDown, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PeriodSelector } from "@/components/ui/period-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMe } from "@/hooks/use-me";
import { usePeriod } from "@/shared/period";

type NavLeaf = { readonly href: string; readonly label: string };

// Mirrors adminProcedure / AdminGate. Roles come from users.role, scoped to
// the caller's Clerk org — never from a JWT claim.
const ADMIN_ROLES: readonly string[] = ["admin", "platform_admin"];

type NavItem =
  | {
      readonly kind: "link";
      readonly href: string;
      readonly label: string;
      readonly adminOnly?: boolean;
    }
  | {
      readonly kind: "group";
      readonly label: string;
      readonly matchPrefixes: readonly string[];
      readonly groups: readonly (readonly NavLeaf[])[];
      readonly adminOnly?: boolean;
    };

const NAV_ITEMS: readonly NavItem[] = [
  { kind: "link", href: "/dashboard", label: "Painel" },
  { kind: "link", href: "/documents", label: "Documentos" },
  { kind: "link", href: "/calibrate", label: "Calibrar" },
  {
    kind: "group",
    label: "Parâmetros",
    matchPrefixes: ["/parameters"],
    groups: [
      [
        { href: "/parameters/tenant-values/business-unit", label: "Unidades" },
        { href: "/parameters/tenant-values/supplier", label: "Fornecedores" },
        { href: "/parameters/tenant-values/customer", label: "Clientes" },
        { href: "/parameters/tenant-values/cash-box", label: "Caixas" },
      ],
    ],
  },
  {
    kind: "group",
    label: "Admin",
    matchPrefixes: ["/admin"],
    adminOnly: true,
    groups: [[{ href: "/admin/lov", label: "Catálogo LOV" }]],
  },
];

function visibleNavItems(items: readonly NavItem[], role: string | null): readonly NavItem[] {
  const isAdmin = role !== null && ADMIN_ROLES.includes(role);
  return items.filter((item) => item.adminOnly !== true || isAdmin);
}

function isActivePath(href: string, location: string): boolean {
  if (href === "/dashboard") return location === "/dashboard" || location === "/";
  return location === href || location.startsWith(`${href}/`);
}

function isGroupActive(prefixes: readonly string[], location: string): boolean {
  return prefixes.some((p) => location === p || location.startsWith(`${p}/`));
}

const navLinkClass =
  "relative inline-flex h-7 items-center text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] transition-colors whitespace-nowrap";

export function AppLayout({ children }: { children: ReactNode }): ReactElement {
  const [location] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const me = useMe();
  const { period, setPeriod } = usePeriod();
  const navItems = visibleNavItems(NAV_ITEMS, me.data?.role ?? null);

  return (
    <div className="min-h-screen bg-[color:var(--paper)]">
      <header className="sticky top-0 z-30 bg-[color:var(--paper)]/95 backdrop-blur-[2px] border-b border-[color:var(--rule-strong)]">
        <div className="mx-auto w-full max-w-[1600px] px-6 lg:px-10">
          <div className="flex items-center gap-6 lg:gap-10 py-3">
            <Link
              href="/dashboard"
              className="font-serif italic font-[500] text-[1.25rem] leading-none tracking-[-0.02em] text-[color:var(--ink)] hover:text-[color:var(--accent)] transition-colors shrink-0"
            >
              ReportFlow
            </Link>

            <nav
              className="hidden lg:flex items-center gap-5 xl:gap-6 flex-1 min-w-0"
              aria-label="Seções"
            >
              {navItems.map((item) => {
                if (item.kind === "link") {
                  const active = isActivePath(item.href, location);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        navLinkClass,
                        active
                          ? "text-[color:var(--ink)]"
                          : "text-[color:var(--ink-mute)] hover:text-[color:var(--ink)]",
                      )}
                    >
                      {item.label}
                      <span
                        aria-hidden
                        className={cn(
                          "absolute left-0 right-0 -bottom-[11px] h-[2px]",
                          "bg-[color:var(--accent)]",
                          "origin-left transition-transform duration-300 ease-[var(--ease-out-quart)]",
                          active ? "scale-x-100" : "scale-x-0",
                        )}
                      />
                    </Link>
                  );
                }

                const active = isGroupActive(item.matchPrefixes, location);
                return (
                  <DropdownMenu key={item.label}>
                    <DropdownMenuTrigger
                      className={cn(
                        navLinkClass,
                        "gap-1 outline-none focus-visible:text-[color:var(--ink)]",
                        active
                          ? "text-[color:var(--ink)]"
                          : "text-[color:var(--ink-mute)] hover:text-[color:var(--ink)]",
                      )}
                    >
                      {item.label}
                      <ChevronDown
                        aria-hidden
                        className="h-3 w-3 transition-transform duration-200 data-[state=open]:rotate-180"
                      />
                      <span
                        aria-hidden
                        className={cn(
                          "absolute left-0 right-0 -bottom-[11px] h-[2px]",
                          "bg-[color:var(--accent)]",
                          "origin-left transition-transform duration-300 ease-[var(--ease-out-quart)]",
                          active ? "scale-x-100" : "scale-x-0",
                        )}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={12} className="min-w-[14rem]">
                      {item.groups.map((leaves, idx) => (
                        <div key={idx}>
                          {idx > 0 && <DropdownMenuSeparator />}
                          {leaves.map((leaf) => {
                            const itemActive = isActivePath(leaf.href, location);
                            return (
                              <DropdownMenuItem
                                key={leaf.href}
                                asChild
                                className={cn(
                                  "cursor-pointer text-[length:var(--fs-body-sm)]",
                                  itemActive &&
                                    "bg-[color:var(--paper-sink)] text-[color:var(--ink)]",
                                )}
                              >
                                <Link href={leaf.href}>{leaf.label}</Link>
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })}
            </nav>

            <div className="flex items-center gap-4 lg:gap-5 ml-auto lg:ml-0 shrink-0">
              <div className="hidden sm:block">
                <PeriodSelector size="compact" value={period} onChange={setPeriod} />
              </div>
              <div className="h-5 w-px bg-[color:var(--rule)] hidden sm:block" aria-hidden />
              <div className="hidden md:flex items-center gap-2 text-[length:var(--fs-body-sm)]">
                {me.data?.name != null && (
                  <span className="text-[color:var(--ink-mute)]">{me.data.name}</span>
                )}
              </div>
              <UserMenu />
              <button
                type="button"
                className="lg:hidden inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--ink)] hover:bg-[color:var(--paper-sink)]"
                aria-label={drawerOpen ? "Fechar menu" : "Abrir menu"}
                onClick={() => {
                  setDrawerOpen((v) => !v);
                }}
              >
                {drawerOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {drawerOpen && (
            <nav
              className="lg:hidden flex flex-col py-2 gap-0.5 animate-in fade-in-50 slide-in-from-top-1 border-t border-[color:var(--rule)]"
              aria-label="Seções"
            >
              {navItems.map((item) => {
                if (item.kind === "link") {
                  const active = isActivePath(item.href, location);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => {
                        setDrawerOpen(false);
                      }}
                      className={cn(
                        "px-2 py-2.5 border-b border-[color:var(--rule)] last:border-b-0",
                        "text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550]",
                        active ? "text-[color:var(--accent)]" : "text-[color:var(--ink-mute)]",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                }

                const groupActive = isGroupActive(item.matchPrefixes, location);
                return (
                  <div
                    key={item.label}
                    className="border-b border-[color:var(--rule)] last:border-b-0"
                  >
                    <div
                      className={cn(
                        "px-2 pt-2.5 pb-1 text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550]",
                        groupActive ? "text-[color:var(--accent)]" : "text-[color:var(--ink-mute)]",
                      )}
                    >
                      {item.label}
                    </div>
                    <div className="flex flex-col pb-1.5">
                      {item.groups.flat().map((leaf) => {
                        const leafActive = isActivePath(leaf.href, location);
                        return (
                          <Link
                            key={leaf.href}
                            href={leaf.href}
                            onClick={() => {
                              setDrawerOpen(false);
                            }}
                            className={cn(
                              "px-4 py-2 text-[length:var(--fs-body-sm)]",
                              leafActive ? "text-[color:var(--accent)]" : "text-[color:var(--ink)]",
                            )}
                          >
                            {leaf.label}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </nav>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] px-6 lg:px-10 py-6 lg:py-8">
        <div className="stagger flex flex-col gap-6 lg:gap-8">{children}</div>
      </main>

      <footer className="mx-auto w-full max-w-[1600px] px-6 lg:px-10 py-6">
        <div className="h-px w-full bg-[color:var(--rule)]" />
        <div className="flex flex-wrap items-baseline justify-between gap-3 pt-3 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          <span className="font-serif italic">ReportFlow</span>
          <span>
            Do caixa à DRE, em um só lugar. <span className="tabular-nums">·</span> Brasil{" "}
            <span className="tabular-nums">·</span> pt-BR
          </span>
        </div>
      </footer>
    </div>
  );
}
