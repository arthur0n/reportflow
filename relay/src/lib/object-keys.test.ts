// relay/src/lib/object-keys.test.ts
//
// A DRIFT GUARD, not a unit test. The behaviour of the predicate is covered
// once, at api/lib/object-keys.test.ts; duplicating those cases here would
// duplicate the very thing this file exists to stop duplicating.
//
// `api/lib/object-keys.ts` says in its own header that two callers need this
// predicate and that "two copies of a predicate like that drift, and the copy
// that drifts is the one nobody was looking at". Both callers are still real:
// the documents router presigns an upload for a key the server names, and the
// relay opens a document for a key a job names. Both hold access to a bucket
// containing every tenant's documents, and in both the only thing separating
// that access from a cross-tenant read is that the key must sit under the
// caller's own prefix.
//
// What changed since that header was written is the packaging: the relay is its
// own bundle with its own package.json, so `sam build` copies only `relay/` and
// a `../../api/lib/...` import would not survive it. The file is therefore
// MIRRORED rather than imported — and this test makes the mirror enforceable.
// If the two ever differ by a single byte, this fails and names both paths.
//
// Fixing a failure here means copying the API's version over the relay's, not
// editing the relay's to match. `api/lib/object-keys.ts` is the original.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELAY_COPY = resolve(import.meta.dirname, "object-keys.ts");
const API_ORIGINAL = resolve(import.meta.dirname, "..", "..", "..", "api", "lib", "object-keys.ts");

describe("object-keys mirror", () => {
  it("is byte-identical to api/lib/object-keys.ts", () => {
    const relay = readFileSync(RELAY_COPY, "utf8");
    const api = readFileSync(API_ORIGINAL, "utf8");
    expect(
      relay,
      `${RELAY_COPY}\nhas drifted from\n${API_ORIGINAL}\n— copy the API's version over it`,
    ).toBe(api);
  });
});
