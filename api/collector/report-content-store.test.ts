// api/collector/report-content-store.test.ts
//
// THE WRITE THAT CAN DESTROY HUMAN PROSE, and the guards that stop it (§5.2,
// §12.13).
//
// "Silently destroying human-written prose on a regen is the kind of bug that
// loses a client." So the cases that matter are the ones where the draft has
// MOVED since the job was built — and, since the codex review, the ones where
// it moves between this function's own load and its own save:
//
//   * a slot edited after the button was pressed is PRESERVED;
//   * a slot edited in the millisecond between load and save is ALSO preserved,
//     because the guard is evaluated by Postgres against the ROW, not against
//     the snapshot this code loaded;
//   * a slot explicitly forced ("regerar mesmo assim") carries NO guard;
//   * a verdict whose prose has been rewritten is DISCARDED, not attached.
//
// TWO THINGS ARE ASSERTED, and they are different: the STATEMENT (does it carry
// the per-slot guard?) and the OUTCOME (does it report what Postgres actually
// stored?). The guard itself is SQL, so a fake handle cannot execute it — what
// a fake CAN prove is that the guard is in the statement and that the outcome is
// derived from `RETURNING` rather than from what the code intended.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "./job-state";
import type * as ReportServiceModule from "../services/report-service";

const service = vi.hoisted(() => ({ loadReportBundle: vi.fn() }));
vi.mock("../services/report-service", async (importOriginal) => {
  const actual = await importOriginal<typeof ReportServiceModule>();
  return { ...actual, loadReportBundle: service.loadReportBundle };
});

const { ANALYSIS_STALE_VERSION, applyAnalysisVerdicts, mergeAnalysisSlots } =
  await import("./report-content-store");
const { slotTextHash } = await import("../analysis/verify-job");

const TENANT = "org_2abcTENANT";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";

const ROLE = {
  key: "faturas",
  documentTypeId: "11111111-1111-4111-8111-111111111111",
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many" as const,
  required: true,
};

const SLOTS = [
  { slug: "parecer", guideline: "Resuma.", maxWords: 120 },
  { slug: "riscos", guideline: "Riscos.", maxWords: 80 },
];

const FATURA = {
  extractionId: "e1",
  documentId: "d1",
  fileName: "f.pdf",
  sortOrder: 0,
  data: { numero: "FT 1", totais: { iliquido: "100,00 €", iva: "23,00 €", documento: "123,00 €" } },
};

/** Long enough to clear `slotAnswerProblem`'s 40-char floor, and every numeral
 * in it is sourced from the fixture above (100,00 / 23,00 / 123,00). */
const CLEAN = "O período reúne uma fatura no valor de 123,00 euros, com IVA de 23,00 euros.";
const OUTRO = "Sem riscos relevantes no período, com IVA de 23,00 euros liquidado na data.";
const INVENTED = "O período reúne uma fatura no valor de 999,99 euros, um número sem fonte alguma.";
const HUMANO = "Prosa escrita por uma pessoa, que nenhuma regeneração pode apagar em silêncio.";

function bundle(over: Record<string, unknown> = {}) {
  return {
    report: { id: REPORT_ID, title: "Agosto", frozenAt: null, clientId: null },
    version: { id: VERSION_ID, version: 1, html: "<p></p>" },
    roles: [ROLE],
    slots: SLOTS,
    content: { slots: {} },
    attached: new Map([[ROLE.key, [FATURA]]]),
    clientName: "House Living",
    ...over,
  };
}

/**
 * The fake handle. `stored` is WHAT POSTGRES WOULD RETURN after evaluating the
 * guards — which is how a case says "the guard refused this slot" without a
 * database. `rows: 0` is the report going frozen mid-write.
 */
function makeDb(opts: { stored?: unknown; rows?: number } = {}) {
  const returning = vi
    .fn()
    .mockResolvedValue(opts.rows === 0 ? [] : [{ contentJson: opts.stored ?? { slots: {} } }]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { db: { update } as unknown as DbLike, set, update };
}

/**
 * Renders the drizzle `SQL` tree the statement was built from, so a case can
 * assert on the GUARD rather than only on the outcome. Params render as their
 * values, which is exactly what makes the slug and the stored JSON visible.
 */
function renderSql(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) {
    return chunks.map(renderSql).join("");
  }
  const value = (node as { value?: unknown }).value;
  if (Array.isArray(value)) {
    return value.join("");
  }
  if (typeof value === "string") {
    return value;
  }
  const name = (node as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function statement(set: ReturnType<typeof makeDb>["set"]): string {
  const payload = set.mock.calls[0]?.[0] as { contentJson?: unknown } | undefined;
  return renderSql(payload?.contentJson);
}

/** The §5.2 guard, as it appears in the statement for one slug. The `::text`
 * cast is part of it: `jsonb -> ?` is ambiguous with an untyped parameter, and
 * dropping the cast is a runtime error in the one place nobody is watching. */
function editedGuardFor(slug: string): string {
  return `-> 'slots' -> ${slug}::text ->> 'edited') is distinct from 'true'`;
}

const CONTEXT = {
  reportId: REPORT_ID,
  templateVersionId: VERSION_ID,
  slugs: ["parecer", "riscos"],
  forced: [],
  extractionIds: ["e1"],
};

/** What Postgres stores when every guard passes. */
function storedBoth(parecer = CLEAN, riscos = OUTRO) {
  return {
    slots: {
      parecer: { text: parecer, edited: false },
      riscos: { text: riscos, edited: false },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("mergeAnalysisSlots — §5.2", () => {
  it("writes the prose for a slot nobody has edited", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({ stored: storedBoth() });

    const out = await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN, riscos: OUTRO });
    expect(out).toMatchObject({ ok: true, merged: ["parecer", "riscos"], preserved: [] });
    expect(statement(set)).toContain(CLEAN);
  });

  // THE CASE §5.2 EXISTS FOR, window one: the human edited before this ran, so
  // the loaded snapshot already knows — and the statement still guards, because
  // the snapshot is not what decides.
  it("PRESERVES a slot a human edited after the job was built", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { riscos: { text: HUMANO, edited: true } } } }),
    );
    // Postgres evaluates the guard: `riscos` is edited, so it keeps the human's.
    const { db, set } = makeDb({ stored: storedBoth(CLEAN, HUMANO) });

    const out = await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN, riscos: OUTRO });
    expect(out).toMatchObject({ merged: ["parecer"], preserved: ["riscos"] });
    expect(statement(set)).toContain(editedGuardFor("riscos"));
  });

  // THE CODEX DEFECT, window two. The snapshot says `riscos` is CLEAN — so the
  // old whole-document save would have overwritten the edit that committed one
  // millisecond later, and reported it merged. The guard is evaluated against
  // the ROW, so Postgres keeps the human's text and the outcome says so.
  it("PRESERVES an edit that lands between the load and the save", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ content: { slots: {} } }));
    const { db, set } = makeDb({ stored: storedBoth(CLEAN, HUMANO) });

    const out = await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN, riscos: OUTRO });
    // The outcome is read from RETURNING, so it cannot claim a write that the
    // row refused — the snapshot said `riscos` was free to overwrite.
    expect(out).toMatchObject({ merged: ["parecer"], preserved: ["riscos"] });
    expect(statement(set)).toContain(editedGuardFor("riscos"));
  });

  // Every non-forced slot carries the guard, and it reads the ROW's column —
  // not the accumulator — so no slot's fate depends on another in the batch.
  it("guards EVERY non-forced slot against the row's own state", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({ stored: storedBoth() });
    await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN, riscos: OUTRO });

    const sql = statement(set);
    expect(sql).toContain(editedGuardFor("parecer"));
    expect(sql).toContain(editedGuardFor("riscos"));
    // One statement, not one per slot: the whole merge is atomic.
    expect(set).toHaveBeenCalledOnce();
  });

  it("overwrites an edited slot the caller explicitly forced, with NO guard", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { riscos: { text: HUMANO, edited: true } } } }),
    );
    const { db, set } = makeDb({
      stored: { slots: { riscos: { text: OUTRO, edited: false } } },
    });

    const out = await mergeAnalysisSlots(
      db,
      TENANT,
      { ...CONTEXT, slugs: ["riscos"], forced: ["riscos"] },
      { riscos: OUTRO },
    );
    expect(out).toMatchObject({ merged: ["riscos"], preserved: [] });
    // Forcing means exactly this: the guard is gone.
    expect(statement(set)).not.toContain(editedGuardFor("riscos"));
  });

  // §5.3 — `content_json.slots` is keyed by slugs a VERSION declares. v1's
  // prose landing in a draft upgraded to v2 is an answer to a question nobody
  // asked, and it can land under a slug v2 gave a different meaning.
  it("merges NOTHING into a draft that moved to another template version", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ version: { id: "other", version: 2, html: "" } }),
    );
    const { db, update } = makeDb();

    await expect(mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN })).resolves.toEqual({
      ok: false,
      reason: ANALYSIS_STALE_VERSION,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("merges nothing into a report that was published mid-flight (§5.1)", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        report: { id: REPORT_ID, title: null, frozenAt: "2026-08-20T00:00:00Z", clientId: null },
      }),
    );
    const { db, update } = makeDb();
    await expect(
      mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN }),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  // `frozen_at IS NULL` is in the WHERE clause too, so a publish landing after
  // the load still wins — and the merge reports that it wrote nothing.
  it("reports a publish that won the race between load and save", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb({ rows: 0 });
    await expect(
      mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("does not let a model invent a slug the version never declared", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await mergeAnalysisSlots(
      db,
      TENANT,
      { ...CONTEXT, slugs: ["parecer"] },
      {
        parecer: CLEAN,
        inventado: CLEAN,
      },
    );
    expect(statement(set)).not.toContain("inventado");
  });
});

describe("mergeAnalysisSlots — §12.12c, stored and flagged rather than failed", () => {
  it("stores prose with an unsourced numeral and records the token", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({
      stored: { slots: { parecer: { text: INVENTED, edited: false, numeralFlags: ["999,99"] } } },
    });

    const out = await mergeAnalysisSlots(
      db,
      TENANT,
      { ...CONTEXT, slugs: ["parecer"] },
      {
        parecer: INVENTED,
      },
    );
    expect(out).toMatchObject({ ok: true, merged: ["parecer"] });
    expect(statement(set)).toContain('"numeralFlags":["999,99"]');
  });

  // Absent, not `[]` — so a reader cannot mistake an empty array on a slot
  // written before the guard ran for "checked and found nothing".
  it("carries no flag key at all on clean prose", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await mergeAnalysisSlots(db, TENANT, { ...CONTEXT, slugs: ["parecer"] }, { parecer: CLEAN });
    expect(statement(set)).not.toContain("numeralFlags");
  });

  // A model that writes four good sections and one two-word stub has produced
  // four good sections.
  it("rejects an unusable slot without discarding the usable ones", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    const out = await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: CLEAN, riscos: "curto" });
    expect(out).toMatchObject({ merged: ["parecer"], rejected: ["riscos"] });
    expect(statement(set)).not.toContain(editedGuardFor("riscos"));
  });

  it("writes nothing at all when every slot is unusable", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db, update } = makeDb();
    const out = await mergeAnalysisSlots(db, TENANT, CONTEXT, { parecer: "x", riscos: "y" });
    expect(out).toMatchObject({ merged: [], rejected: ["parecer", "riscos"] });
    expect(update).not.toHaveBeenCalled();
  });

  // New prose retires every verdict about the prose it replaced.
  it("clears a previous verdict when the slot is rewritten", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        content: {
          slots: {
            parecer: {
              text: "antigo",
              edited: false,
              refuted: [{ claim: "x", fundamento: "y" }],
              verifiedAt: "2026-08-19T00:00:00Z",
            },
          },
        },
      }),
    );
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await mergeAnalysisSlots(db, TENANT, { ...CONTEXT, slugs: ["parecer"] }, { parecer: CLEAN });
    const sql = statement(set);
    expect(sql).not.toContain("refuted");
    expect(sql).not.toContain("verifiedAt");
  });
});

// ---------------------------------------------------------------------------
// §12.13 — a verdict is bound to the text it judged
// ---------------------------------------------------------------------------

describe("applyAnalysisVerdicts", () => {
  function target(text: string, slug = "parecer") {
    return {
      reportId: REPORT_ID,
      templateVersionId: VERSION_ID,
      textHashes: { [slug]: slotTextHash(text) },
    };
  }

  it("records refuted claims on the slot it judged, and never touches its text", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: CLEAN, edited: false } } } }),
    );
    const { db, set } = makeDb();
    // Postgres echoes back what it stored; the stamp is what proves the write.
    set.mockImplementation((payload: { contentJson: unknown }) => ({
      where: () => ({
        returning: () =>
          Promise.resolve([
            {
              contentJson: {
                slots: {
                  parecer: {
                    text: CLEAN,
                    edited: false,
                    refuted: [{ claim: "123,00 euros", fundamento: "não confere" }],
                    verifiedAt: stampIn(renderSql(payload.contentJson)),
                  },
                },
              },
            },
          ]),
      }),
    }));

    const out = await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "123,00 euros", verdict: "refutado", fundamento: "não confere" },
      { slot: "parecer", claim: "uma fatura", verdict: "confirmado", fundamento: null },
    ]);
    expect(out).toMatchObject({ ok: true, merged: ["parecer"], obsolete: [] });
    const sql = statement(set);
    expect(sql).toContain('"claim":"123,00 euros"');
    // The verifier NEVER rewrites: the stored text is the one it was shown.
    expect(sql).toContain(CLEAN);
  });

  // THE CODEX DEFECT. The verifier judged the OLD prose; a human rewrote the
  // slot while the hop ran. Attaching the verdict would block publication over
  // a finding about words that no longer exist.
  it("DISCARDS a verdict whose prose was rewritten while the hop ran", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: HUMANO, edited: true } } } }),
    );
    const { db, update } = makeDb();

    const out = await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "123,00 euros", verdict: "refutado", fundamento: "não confere" },
    ]);
    expect(out).toMatchObject({ ok: true, merged: [], obsolete: ["parecer"] });
    // Nothing is written at all — not even a clean `verifiedAt`, which would
    // claim the new prose had been checked.
    expect(update).not.toHaveBeenCalled();
  });

  // The load → save window, closed by the row's own text rather than by hope.
  it("guards the write on the exact text the verifier was shown", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: CLEAN, edited: false } } } }),
    );
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "c", verdict: "confirmado", fundamento: null },
    ]);
    expect(statement(set)).toContain(
      `-> 'slots' -> parecer::text ->> 'text') is not distinct from`,
    );
  });

  // The same edit, landing one millisecond later: Postgres refuses the guard,
  // the stamp never appears, and the slot reports obsolete rather than clean.
  it("reports a slot the row refused between load and save as obsolete", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: CLEAN, edited: false } } } }),
    );
    const { db } = makeDb({
      stored: { slots: { parecer: { text: HUMANO, edited: true } } },
    });
    const out = await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "c", verdict: "refutado", fundamento: "x" },
    ]);
    expect(out).toMatchObject({ merged: [], obsolete: ["parecer"] });
  });
});

describe("applyAnalysisVerdicts — what a badge is allowed to say", () => {
  function target(text: string, slug = "parecer") {
    return {
      reportId: REPORT_ID,
      templateVersionId: VERSION_ID,
      textHashes: { [slug]: slotTextHash(text) },
    };
  }

  // "Verified and clean" and "never verified" are different facts, and a badge
  // that cannot tell them apart says nothing.
  it("stamps verifiedAt on a MATCHING clean pass, with no refuted key", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: CLEAN, edited: false } } } }),
    );
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "c", verdict: "confirmado", fundamento: null },
    ]);
    const sql = statement(set);
    expect(sql).toContain('"verifiedAt"');
    expect(sql).not.toContain('"refuted"');
  });

  // `ilegivel` means the verifier could not decide. That is not a finding
  // against the prose and must not block a publication.
  it("does not flag an illegible verdict", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { parecer: { text: CLEAN, edited: false } } } }),
    );
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: false } } } });
    await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "c", verdict: "ilegivel", fundamento: "dados insuficientes" },
    ]);
    expect(statement(set)).not.toContain('"refuted"');
  });

  // A second pass that CONFIRMS what the first refuted must clear the flag —
  // otherwise the report stays blocked on a finding that has been withdrawn.
  it("clears a stale refutation on a re-verify, and keeps `edited`", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        content: {
          slots: {
            parecer: { text: CLEAN, edited: true, refuted: [{ claim: "x", fundamento: null }] },
          },
        },
      }),
    );
    const { db, set } = makeDb({ stored: { slots: { parecer: { text: CLEAN, edited: true } } } });
    await applyAnalysisVerdicts(db, TENANT, target(CLEAN), [
      { slot: "parecer", claim: "x", verdict: "confirmado", fundamento: null },
    ]);
    const sql = statement(set);
    expect(sql).not.toContain('"refuted"');
    // A verdict is not an edit.
    expect(sql).toContain('"edited":true');
  });
});

/** Digs this call's `verifiedAt` out of the statement, so the fake can echo the
 * exact stamp Postgres would have stored. */
function stampIn(sqlText: string): string {
  return /"verifiedAt":"([^"]+)"/u.exec(sqlText)?.[1] ?? "";
}
