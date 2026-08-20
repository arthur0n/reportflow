// api/detection/classify-job.test.ts
//
// Tier 2 (decisions §3.3, §12.2): the canonical relay job payload shape and
// the label→id map used to resolve its answer. What matters here is that the
// payload matches relay/src/job.ts's `AiJob` contract exactly (a job the
// relay's own `parseJob` would refuse is a job that never runs), and that the
// schema's enum always carries every candidate PLUS the "none of these"
// escape hatch.

import { describe, it, expect, vi } from "vitest";
import type { DbLike } from "../collector/job-state";
import {
  buildDetectJob,
  DETECT_MODEL,
  DETECT_PROVIDER,
  loadClassifiableTypes,
  UNKNOWN_TYPE_LABEL,
  type ClassifiableType,
} from "./classify-job";

const TENANT = "org_2abcTENANT";

function makeJoinDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn().mockReturnValue({ where });
  const innerJoin = vi.fn().mockReturnValue({ leftJoin });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DbLike };
}

describe("loadClassifiableTypes", () => {
  it("labels as 'provider / type', and defaults hints to [] when no template row joined", async () => {
    const { db } = makeJoinDb([
      {
        documentTypeId: "dt-1",
        typeName: "Nota Fiscal",
        providerName: "Toysmith",
        detectHint: null,
      },
      {
        documentTypeId: "dt-2",
        typeName: "Fatura",
        providerName: "House Living",
        detectHint: ["House Living", "Fatura"],
      },
    ]);
    const types = await loadClassifiableTypes(db, TENANT);
    expect(types).toEqual([
      { documentTypeId: "dt-1", label: "Toysmith / Nota Fiscal", hints: [] },
      {
        documentTypeId: "dt-2",
        label: "House Living / Fatura",
        hints: ["House Living", "Fatura"],
      },
    ]);
  });
});

const TYPES: ClassifiableType[] = [
  { documentTypeId: "dt-1", label: "Toysmith / Nota Fiscal", hints: ["TOYSMITH"] },
  { documentTypeId: "dt-2", label: "House Living / Fatura", hints: [] },
];

describe("buildDetectJob", () => {
  it("builds a payload matching the relay's canonical AiJob shape", () => {
    const { payload } = buildDetectJob({
      tenantId: TENANT,
      s3Key: `${TENANT}/doc.pdf`,
      types: TYPES,
    });

    expect(payload["channel"]).toBe("ai");
    expect(payload["kind"]).toBe("detect");
    expect(payload["tenantId"]).toBe(TENANT);
    expect(payload["provider"]).toBe(DETECT_PROVIDER);
    expect(payload["model"]).toBe(DETECT_MODEL);
    expect(typeof payload["system"]).toBe("string");
    expect(typeof payload["prompt"]).toBe("string");
    expect(payload["document"]).toEqual({ s3Key: `${TENANT}/doc.pdf` });
    expect(typeof payload["maxTokens"]).toBe("number");
    expect(payload["maxTokens"]).toBeGreaterThan(0);
  });

  it("lists every candidate's label in the prompt", () => {
    const { payload } = buildDetectJob({
      tenantId: TENANT,
      s3Key: `${TENANT}/doc.pdf`,
      types: TYPES,
    });
    const prompt = payload["prompt"] as string;
    expect(prompt).toContain("Toysmith / Nota Fiscal");
    expect(prompt).toContain("House Living / Fatura");
  });

  it("schema enum carries every label plus the unknown sentinel", () => {
    const { payload } = buildDetectJob({
      tenantId: TENANT,
      s3Key: `${TENANT}/doc.pdf`,
      types: TYPES,
    });
    const schema = payload["schema"] as {
      properties: { document_type: { enum: string[] } };
    };
    expect(schema.properties.document_type.enum).toEqual([
      "Toysmith / Nota Fiscal",
      "House Living / Fatura",
      UNKNOWN_TYPE_LABEL,
    ]);
  });

  it("the label→id map resolves every candidate's own label", () => {
    const { labelToDocumentTypeId } = buildDetectJob({
      tenantId: TENANT,
      s3Key: `${TENANT}/doc.pdf`,
      types: TYPES,
    });
    expect(labelToDocumentTypeId.get("Toysmith / Nota Fiscal")).toBe("dt-1");
    expect(labelToDocumentTypeId.get("House Living / Fatura")).toBe("dt-2");
    expect(labelToDocumentTypeId.get(UNKNOWN_TYPE_LABEL)).toBeUndefined();
  });

  it("refuses to build a job with no document types to classify against", () => {
    expect(() =>
      buildDetectJob({ tenantId: TENANT, s3Key: `${TENANT}/doc.pdf`, types: [] }),
    ).toThrow();
  });
});
