// shared/validation/import-match-rule-schemas.test.ts
//
// Field-level contract for the import_match_rules CRUD inputs. Regex compile
// validation lives in the router (where it can throw a tRPC BAD_REQUEST);
// here we cover only the shape constraints.

import { describe, it, expect } from "vitest";
import {
  CreateTenantRuleInput,
  CreateSystemRuleInput,
  UpdateTenantRuleInput,
  UpdateSystemRuleInput,
  ListTenantRulesInput,
  ListSystemRulesInput,
} from "./import-match-rule-schemas";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

describe("CreateTenantRuleInput", () => {
  it("accepts a CATEGORY rule with lovTargetId", () => {
    const parsed = CreateTenantRuleInput.parse({
      targetKind: "CATEGORY",
      matchKind: "contains",
      pattern: "IFOOD",
      lovTargetId: UUID,
    });
    expect(parsed.targetKind).toBe("CATEGORY");
    expect(parsed.lovTargetId).toBe(UUID);
  });

  it("accepts a SUPPLIER rule with tvTargetId", () => {
    const parsed = CreateTenantRuleInput.parse({
      targetKind: "SUPPLIER",
      matchKind: "regex",
      pattern: "^IFOOD",
      tvTargetId: UUID,
    });
    expect(parsed.targetKind).toBe("SUPPLIER");
    expect(parsed.tvTargetId).toBe(UUID);
  });

  it("rejects unknown targetKind", () => {
    expect(() =>
      CreateTenantRuleInput.parse({
        targetKind: "BANK_SLUG",
        matchKind: "contains",
        pattern: "X",
        lovTargetId: UUID,
      }),
    ).toThrow();
  });

  it("rejects unknown matchKind", () => {
    expect(() =>
      CreateTenantRuleInput.parse({
        targetKind: "CATEGORY",
        matchKind: "fuzzy",
        pattern: "X",
        lovTargetId: UUID,
      }),
    ).toThrow();
  });

  it("rejects empty pattern", () => {
    expect(() =>
      CreateTenantRuleInput.parse({
        targetKind: "CATEGORY",
        matchKind: "contains",
        pattern: "   ",
        lovTargetId: UUID,
      }),
    ).toThrow();
  });

  it("rejects confidence > 100", () => {
    expect(() =>
      CreateTenantRuleInput.parse({
        targetKind: "CATEGORY",
        matchKind: "contains",
        pattern: "X",
        lovTargetId: UUID,
        confidence: 101,
      }),
    ).toThrow();
  });

  it("rejects negative priority", () => {
    expect(() =>
      CreateTenantRuleInput.parse({
        targetKind: "CATEGORY",
        matchKind: "contains",
        pattern: "X",
        lovTargetId: UUID,
        priority: -1,
      }),
    ).toThrow();
  });
});

describe("CreateSystemRuleInput", () => {
  it("requires lovTargetId", () => {
    expect(() =>
      CreateSystemRuleInput.parse({
        targetKind: "PAYMENT_METHOD",
        matchKind: "contains",
        pattern: "BOLETO",
      }),
    ).toThrow();
  });

  it("accepts an audience-scoped category", () => {
    const parsed = CreateSystemRuleInput.parse({
      targetKind: "PAYMENT_METHOD",
      matchKind: "contains",
      pattern: "BOLETO",
      lovTargetId: UUID,
      category: "restaurant",
    });
    expect(parsed.category).toBe("restaurant");
  });

  it("accepts a null category (universal audience)", () => {
    const parsed = CreateSystemRuleInput.parse({
      targetKind: "PAYMENT_METHOD",
      matchKind: "contains",
      pattern: "BOLETO",
      lovTargetId: UUID,
      category: null,
    });
    expect(parsed.category).toBeNull();
  });
});

describe("UpdateTenantRuleInput / UpdateSystemRuleInput", () => {
  it("accepts a partial patch with only id", () => {
    const parsed = UpdateTenantRuleInput.parse({ id: UUID });
    expect(parsed.id).toBe(UUID);
  });

  it("accepts a description=null clear", () => {
    const parsed = UpdateTenantRuleInput.parse({ id: UUID, description: null });
    expect(parsed.description).toBeNull();
  });

  it("system update accepts category=null clear", () => {
    const parsed = UpdateSystemRuleInput.parse({ id: UUID_2, category: null });
    expect(parsed.category).toBeNull();
  });
});

describe("ListTenantRulesInput / ListSystemRulesInput", () => {
  it("defaults status to 'active'", () => {
    const parsed = ListTenantRulesInput.parse({});
    expect(parsed.status).toBe("active");
  });

  it("system list defaults status to 'active'", () => {
    const parsed = ListSystemRulesInput.parse({});
    expect(parsed.status).toBe("active");
  });

  it("rejects unknown status", () => {
    expect(() => ListTenantRulesInput.parse({ status: "archived" })).toThrow();
  });
});
