// Whether any statement import is still uploading/parsing. Pages the flow
// lands on right after an upload (conferência) key their refetchInterval on
// this so freshly parsed data appears without a manual refresh.

import { trpc } from "@/shared/lib/trpc";

const BUSY_STATUSES = ["uploaded_pending", "parsing"];

export function useImportsBusy(): boolean {
  const q = trpc.statementImports.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      if (!items) return false;
      return items.some((i) => BUSY_STATUSES.includes(i.status)) ? 2000 : false;
    },
  });
  return (q.data?.items ?? []).some((i) => BUSY_STATUSES.includes(i.status));
}
