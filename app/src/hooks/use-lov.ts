import { useMemo } from "react";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

type LovItem = TrpcOutput["listOfValues"]["list"][number];

export type UseLovResult = {
  items: LovItem[];
  byCode: Map<string, LovItem>;
  byId: Map<string, LovItem>;
  label: (code: string | null | undefined, fallback?: string) => string;
  labelById: (id: string | null | undefined, fallback?: string) => string;
  isLoading: boolean;
};

/**
 * Fetch the active LOV rows for a given `type`. Cached for the session —
 * LOV values rarely change and are read on every page render.
 */
export function useLov(type: string): UseLovResult {
  const q = trpc.listOfValues.list.useQuery({ type }, { staleTime: Infinity });

  const items = q.data ?? [];
  const byCode = useMemo(() => new Map(items.map((r) => [r.code, r])), [items]);
  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);

  return {
    items,
    byCode,
    byId,
    label: (code, fallback = "") => {
      if (code === null || code === undefined || code.length === 0) return fallback;
      const found = byCode.get(code)?.value;
      if (typeof found === "string") return found;
      return fallback.length > 0 ? fallback : code;
    },
    labelById: (id, fallback = "") => {
      if (id === null || id === undefined || id.length === 0) return fallback;
      const found = byId.get(id)?.value;
      if (typeof found === "string") return found;
      return fallback;
    },
    isLoading: q.isLoading,
  };
}
