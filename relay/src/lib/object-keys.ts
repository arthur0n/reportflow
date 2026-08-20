// api/lib/object-keys.ts
//
// The ownership predicate for S3 object keys, in ONE place.
//
// Two callers need it and they are on opposite sides of the same boundary:
//
//   * the documents router, which presigns an upload for a key the SERVER
//     names (api/lib/storage.ts), and
//   * the relay, which opens a document for a key a `documents` row names
//     (decisions §3.3, tier 2 classification).
//
// Both hold, or hand out, access to a bucket containing every tenant's
// documents, and in both the only thing separating that access from a
// cross-tenant read is that the key must sit under the caller's own prefix.
// Two copies of a predicate like that drift, and the copy that drifts is the
// one nobody was looking at. It lives here so there is nothing to drift from.
//
// Deliberately dependency-free: no aws-sdk, no trpc. The relay and the API are
// separate bundles, and each caller maps ObjectKeyError onto its own error
// vocabulary (PermanentError in the relay, a TRPCError in the router).

/** S3's own limit. A key longer than this cannot exist, so accepting one is a
 * request we would only make to be refused. */
export const MAX_OBJECT_KEY = 1_024;

export class ObjectKeyError extends Error {
  override readonly name = "ObjectKeyError";
}

/**
 * Proves `key` is a well formed object key. SHAPE ONLY, no ownership.
 *
 * Used on the read path, where authorization is by reachability rather than by
 * prefix: the caller has already established a right to the key by pointing at
 * a row that references it, and only the key's shape is still in question.
 */
export function assertPlainKey(key: unknown, label = "key"): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new ObjectKeyError(`${label} is required`);
  }
  if (key.length > MAX_OBJECT_KEY) {
    throw new ObjectKeyError(`${label} is too long`);
  }
  if (key.includes("..") || key.startsWith("/")) {
    throw new ObjectKeyError(`${label} must be a plain object key`);
  }
  return key;
}

/**
 * Proves `key` is a plain object key OWNED by `owner`, or throws.
 *
 * Used on the WRITE path only. The ORDER matters: traversal is refused before
 * the prefix is compared, so `org-1/../org-2/x.pdf` cannot satisfy the owner
 * prefix and then climb out of it. Reversing those two steps reintroduces
 * exactly the cross-tenant write the function exists to prevent, and nothing
 * about the code would look wrong.
 *
 * The trailing slash in the prefix is also load-bearing: without it `org-1`
 * matches `org-10/secret.pdf`, and ids that share a prefix are ordinary rather
 * than exotic.
 */
export function assertOwnedKey(key: unknown, owner: string, label = "key"): string {
  if (owner.length === 0) {
    // A caller with no identity must never reach a prefix comparison, because
    // `""` prefixes every string. Failing loudly beats matching everything.
    throw new ObjectKeyError("owner is required");
  }
  const plain = assertPlainKey(key, label);
  if (!plain.startsWith(`${owner}/`)) {
    throw new ObjectKeyError(`${label} does not belong to the caller`);
  }
  return plain;
}
