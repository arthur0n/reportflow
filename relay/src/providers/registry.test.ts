// relay/src/providers/registry.test.ts
//
// The registry is the load-bearing half of §6's "provider-agnostic by
// construction". These cases pin the two properties that make the claim true:
// dispatch is by name with no default, and an unknown name is answered rather
// than retried.

import { describe, it, expect } from "vitest";
import { getAdapter, knownProviders } from "./registry";
import { geminiAdapter } from "./gemini";
import { PermanentError } from "../errors";

describe("provider registry", () => {
  it("dispatches to the adapter named by the job", () => {
    expect(getAdapter("gemini")).toBe(geminiAdapter);
  });

  // Catches: a `provider` key on the registry entry that disagrees with the
  // key it is filed under. The result envelope reports `provider`, and billing
  // keys include it (§12.6), so a mismatch mis-files a charge.
  it("files every adapter under its own provider id", () => {
    for (const name of knownProviders()) {
      expect(getAdapter(name).provider).toBe(name);
    }
  });

  // Catches: falling back to a default provider. A default is a fourth place
  // that decides the provider, and §6 makes it a per-account, per-hop choice.
  it("refuses an unknown provider instead of substituting one", () => {
    expect(() => getAdapter("anthropic")).toThrow(PermanentError);
    expect(() => getAdapter("anthropic")).toThrow(/unknown provider/u);
  });

  // Catches: a plain object lookup reaching Object.prototype. `getAdapter
  // ("constructor")` must not return a function.
  it("does not resolve inherited object properties as adapters", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => getAdapter(name)).toThrow(PermanentError);
    }
  });

  it("lists what it can serve, for the error message and for the next adapter", () => {
    expect(knownProviders()).toEqual(["gemini"]);
  });
});
