// api/lib/object-keys.test.ts
//
// This predicate is the tenant boundary for the documents bucket on BOTH
// sides: the documents router will not sign an upload for a key it rejects,
// and the relay will not open a document for one. Neither has a second line
// of defence behind it, because the bucket blocks public access and both
// roles hold s3:GetObject on every key in it.
//
// Each case names the broken implementation it catches.

import { describe, it, expect } from "vitest";
import { assertOwnedKey, assertPlainKey, ObjectKeyError, MAX_OBJECT_KEY } from "./object-keys";

const OWNER = "org-1";

describe("assertOwnedKey", () => {
  it("returns the key it was given when the caller owns it", () => {
    expect(assertOwnedKey(`${OWNER}/invoice.pdf`, OWNER)).toBe(`${OWNER}/invoice.pdf`);
    expect(assertOwnedKey(`${OWNER}/nested/invoice.pdf`, OWNER)).toBe(
      `${OWNER}/nested/invoice.pdf`,
    );
  });

  // Catches: dropping the prefix comparison. This is the whole point of the
  // function, and the key below is perfectly well formed.
  it("refuses a well formed key belonging to another caller", () => {
    expect(() => assertOwnedKey("org-2/invoice.pdf", OWNER)).toThrow(
      /does not belong to the caller/,
    );
  });

  // Catches: comparing with `startsWith(owner)` and no trailing slash. Ids that
  // share a prefix are ordinary, not exotic: org-1 must not reach org-10.
  it("refuses a sibling whose id merely starts the same way", () => {
    expect(() => assertOwnedKey("org-10/invoice.pdf", OWNER)).toThrow(ObjectKeyError);
    expect(() => assertOwnedKey("org-1x/invoice.pdf", OWNER)).toThrow(ObjectKeyError);
  });

  // Catches: using `includes(owner)` instead of a prefix comparison.
  it("refuses a key that merely mentions the owner somewhere inside it", () => {
    expect(() => assertOwnedKey(`org-2/${OWNER}/invoice.pdf`, OWNER)).toThrow(ObjectKeyError);
  });

  // Catches: running the traversal check AFTER the prefix check, or removing
  // it. This key satisfies the owner prefix and still resolves elsewhere, so
  // the ORDER of those two lines is the property, not their presence.
  it("refuses traversal out of the owner's own prefix", () => {
    expect(() => assertOwnedKey(`${OWNER}/../org-2/invoice.pdf`, OWNER)).toThrow(
      /plain object key/,
    );
  });

  it.each([
    ["an absolute key", "/org-1/invoice.pdf"],
    ["a bare traversal", ".."],
    ["an empty key", ""],
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, key) => {
    expect(() => assertOwnedKey(key, OWNER)).toThrow(ObjectKeyError);
  });

  // Catches: dropping the length cap. S3 cannot store a longer key, so the only
  // thing accepting one buys is a request made to be refused.
  it("refuses a key longer than S3 allows and accepts one exactly at the limit", () => {
    const tail = "x".repeat(MAX_OBJECT_KEY - OWNER.length - 1);
    expect(() => assertOwnedKey(`${OWNER}/${tail}`, OWNER)).not.toThrow();
    expect(() => assertOwnedKey(`${OWNER}/${tail}x`, OWNER)).toThrow(/too long/);
  });

  // Catches: dropping the owner guard. An empty owner prefixes EVERY string, so
  // a caller with no identity would otherwise be granted every key in the
  // bucket by the very check meant to constrain it.
  it("refuses an empty owner rather than matching everything", () => {
    expect(() => assertOwnedKey("org-2/invoice.pdf", "")).toThrow(/owner is required/);
    expect(() => assertOwnedKey("/invoice.pdf", "")).toThrow(/owner is required/);
  });

  it("uses the label in its message, so the caller's field name survives", () => {
    expect(() => assertOwnedKey("org-2/x.pdf", OWNER, "storagePath")).toThrow(/^storagePath /);
  });
});

describe("assertPlainKey", () => {
  // The read path uses this one, because authorization there is reachability,
  // not prefix. It must therefore NOT reject a key belonging to someone else:
  // the relay opening a document referenced by a tenant-visible row is the
  // behaviour the app wants.
  it("accepts a key belonging to another tenant", () => {
    expect(assertPlainKey("org-2/invoice.pdf")).toBe("org-2/invoice.pdf");
  });

  // Catches: dropping the shape checks on the read path. A reachable key came
  // out of a database column, and a column holds whatever a past writer put in
  // it, including a key written before these rules existed.
  it.each([
    ["traversal", "org-1/../org-2/invoice.pdf"],
    ["an absolute key", "/org-2/invoice.pdf"],
    ["an empty key", ""],
    ["a non-string", 42],
  ])("still refuses %s", (_label, key) => {
    expect(() => assertPlainKey(key)).toThrow(ObjectKeyError);
  });

  // Catches: assertOwnedKey drifting away from assertPlainKey, for instance by
  // someone adding a shape rule to one and not the other. Ownership is meant to
  // be assertPlainKey PLUS a prefix, not a second implementation of it.
  it("is the shape half of assertOwnedKey, with nothing extra in either", () => {
    for (const bad of ["", "..", "/x.pdf", "org-1/../x.pdf"]) {
      const plain = (): unknown => assertPlainKey(bad, "k");
      const owned = (): unknown => assertOwnedKey(bad, "org-1", "k");
      let plainMessage = "";
      let ownedMessage = "";
      try {
        plain();
      } catch (err) {
        plainMessage = (err as Error).message;
      }
      try {
        owned();
      } catch (err) {
        ownedMessage = (err as Error).message;
      }
      expect(plainMessage).not.toBe("");
      expect(ownedMessage).toBe(plainMessage);
    }
  });
});
