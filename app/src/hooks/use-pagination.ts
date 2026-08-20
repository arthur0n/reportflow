import { useMemo } from "react";

export type PageSize = 10 | 25 | 50 | 100;

export const PAGE_SIZE_OPTIONS: readonly PageSize[] = [10, 25, 50, 100];

export function isPageSize(n: unknown): n is PageSize {
  return typeof n === "number" && (PAGE_SIZE_OPTIONS as readonly number[]).includes(n);
}

export type PaginationState = {
  page: number;
  pageSize: PageSize;
};

export type PaginationResult<T> = {
  rows: T[];
  page: number;
  pageSize: PageSize;
  totalRows: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
};

// Client-side pager. The result shape mirrors what a server-paged endpoint
// would return, so swapping the data source later (pass already-paged rows
// + a known totalRows) does not change the consumer contract.
export function usePagination<T>(
  allRows: readonly T[],
  state: PaginationState,
): PaginationResult<T> {
  return useMemo(() => {
    const totalRows = allRows.length;
    const pageSize = state.pageSize;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const page = Math.min(Math.max(1, state.page), totalPages);
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, totalRows);
    return {
      rows: allRows.slice(start, end),
      page,
      pageSize,
      totalRows,
      totalPages,
      startIndex: totalRows === 0 ? 0 : start + 1,
      endIndex: end,
    };
  }, [allRows, state.page, state.pageSize]);
}
