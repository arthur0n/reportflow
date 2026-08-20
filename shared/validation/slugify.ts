const COMBINING_MARKS_RE = /[̀-ͯ]/g;
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g;
const TRIM_HYPHENS_RE = /^-+|-+$/g;

const SLUG_MAX_LENGTH = 50;

/**
 * Slugify an LOV `value` into its canonical `code` form.
 *
 * NFKD-decompose, strip combining marks, lowercase, replace runs of
 * non-alphanumeric characters with `-`, trim hyphens, cap at the column
 * length. Used by the LOV-CRUD core for every tenant-scoped LOV write.
 *
 * Empty input or input that produces an empty slug throws — the LOV-CRUD
 * core surfaces this as a 400 with a meaningful message rather than a DB
 * error.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RE, "-")
    .replace(TRIM_HYPHENS_RE, "")
    .slice(0, SLUG_MAX_LENGTH);
}
