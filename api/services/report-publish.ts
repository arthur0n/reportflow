// api/services/report-publish.ts
//
// RENDER and PUBLISH (decisions §5.1, §5.4, §12.12c). Split from
// report-service.ts on the same seam as calibration-freeze.ts: everything
// there edits a mutable draft, everything here produces — or reads back — the
// immutable artifact.
//
// THE PUBLISH PROTOCOL, in order, and why the order is the protocol:
//
//   1. required roles filled          -> else "aguardando: contrato" (§3.2)
//   2. every declared slot has prose  -> a placeholder is not a report
//   3. NUMERAL GUARD on every slot    -> §12.12c, blocks publication
//   3b. NO REFUTED CLAIMS on any slot -> §12.13, blocks publication
//   4. render                         -> the §12.4 engine, escaping on
//   5. PUT the HTML to a PER-ATTEMPT key -> before the row is stamped
//   6. compare-and-set frozen_at         -> WHERE frozen_at IS NULL, stamping
//                                           the key this attempt just wrote
//
// 5 BEFORE 6 IS DELIBERATE. Stamping first and writing second leaves a report
// the UI calls published whose artifact does not exist — a broken document at
// the exact moment a client is being sent one. Writing first leaves, at worst,
// an object no row points at, and the loser deletes its own.
//
// 6 IS A COMPARE-AND-SET for the same reason `report_jobs` transitions are
// (§12.1): two tabs, one double-click, one retried request. `WHERE frozen_at
// IS NULL` means the second writer loses, re-reads, and reports the winner's
// artifact instead of minting a second `frozen_at` for one report.
//
// AND THE KEY IS PER-ATTEMPT, WHICH IS WHAT MAKES 6 ACTUALLY SAFE (codex
// review). With one derived key per REPORT, the CAS picked a winner but both
// publishers wrote the same object — and nothing orders the loser's PUT before
// the winner's. A loser that is simply slow overwrites the archive the
// winner's row already points at, after publication, with bytes rendered from
// a different draft state. No ordering of steps 5 and 6 fixes that; only not
// sharing the key does. Each attempt writes `frozen/{tenant}/{report}/{uuid}`
// and the CAS stamps the key IT wrote, so the row names the exact bytes that
// were approved. The loser then deletes its own object, best-effort: an
// orphan is unreferenced bytes, and failing a publish because a cleanup failed
// would be a worse outcome for the same fact.

import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { reports } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import { renderTemplate } from "../render/handlebars";
import { auditSlots, harvestNumerals } from "../render/numeral-guard";
import { refutedSlots, slotTexts } from "../render/report-content";
import { loadReportBundle, reportContextOf } from "./report-service";
import { slotPlaceholder } from "./outbound-template-service";

export interface PublishDeps {
  readonly db: DbLike;
  /** Mints a FRESH key on every call — see the header. */
  readonly frozenKey: (tenantId: string, reportId: string) => string;
  readonly putFrozen: (key: string, html: string) => Promise<void>;
  readonly getFrozen: (key: string) => Promise<string | null>;
  /** Removes one attempt's orphan after a lost compare-and-set. */
  readonly deleteFrozen: (key: string) => Promise<void>;
}

export interface PublishCtx {
  readonly tenantId: string;
  readonly userId: string;
}

/** §12.12b's context, built by the ONE builder every hop shares
 * (api/services/report-service.ts `reportContextOf`) — see the comment there
 * on why a second one would make the §12.13 verifier lie. */
const contextFor = reportContextOf;

// ---------------------------------------------------------------------------
// render — one procedure, two sources
// ---------------------------------------------------------------------------

export type RenderedReport =
  /** A required role has no document. §3.2's showable waiting state — not an
   * error, because nothing is wrong yet. */
  | { readonly status: "aguardando"; readonly missingRoles: readonly string[] }
  | {
      readonly status: "rascunho";
      readonly html: string;
      /** Advisory here, BLOCKING at publish. A draft that refused to render on
       * a bad numeral would hide the very prose a human has to fix. */
      readonly numeralViolations: readonly { slot: string; token: string }[];
      readonly missingSlots: readonly string[];
      /** §12.13 — slots the verifier would not confirm. Same policy as the
       * numerals: shown here, refused at publish. */
      readonly contestedSlots: readonly string[];
    }
  | {
      readonly status: "publicado";
      /** null when the archived object is gone. The row still says published,
       * and the screen says so, rather than throwing at a user who did
       * nothing wrong. */
      readonly html: string | null;
      readonly frozenAt: string;
      readonly frozenKey: string;
    };

/**
 * A PUBLISHED REPORT IS PRINTED FROM WHAT WAS ARCHIVED, never from a
 * re-render. That is the entire point of freezing it (§5.1): a template fix
 * must not retroactively change a document someone's customer already
 * received. A draft renders live, so a template fix DOES reach it — which is
 * the other half of the same decision.
 */
export async function renderReport(
  deps: PublishDeps,
  tenantId: string,
  reportId: string,
): Promise<RenderedReport> {
  const bundle = await loadReportBundle(deps.db, tenantId, reportId);

  if (bundle.report.frozenAt !== null && bundle.report.frozenHtmlS3Key !== null) {
    const html = await deps.getFrozen(bundle.report.frozenHtmlS3Key);
    return {
      status: "publicado",
      html,
      frozenAt: bundle.report.frozenAt,
      frozenKey: bundle.report.frozenHtmlS3Key,
    };
  }

  const built = contextFor(bundle);
  if (built.missingRequiredRoles.length > 0) {
    return { status: "aguardando", missingRoles: built.missingRequiredRoles };
  }

  const texts = slotTexts(bundle.content);
  const missingSlots = bundle.slots
    .filter((slot) => (texts[slot.slug] ?? "").trim().length === 0)
    .map((slot) => slot.slug);

  let html: string;
  try {
    html = renderTemplate(bundle.version.html, built.context, {
      slots: texts,
      missingSlotText: slotPlaceholder,
    });
  } catch (err) {
    throw asRenderError(err);
  }

  return {
    status: "rascunho",
    html,
    numeralViolations: auditSlots(texts, harvestNumerals(built.context)),
    missingSlots,
    contestedSlots: refutedSlots(bundle.content).map((s) => s.slug),
  };
}

/** A render failure on a SAVED version is not the reader's fault — the version
 * passed its fixture dry run at save time, so this means the real data has a
 * shape the fixture did not. Surfaced as BAD_REQUEST with the engine's own
 * message, which names the missing path. */
function asRenderError(err: unknown): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `O modelo não renderiza com estes documentos: ${message}`,
  });
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export interface PublishOutcome {
  readonly frozenAt: string;
  readonly frozenKey: string;
  /** True when this call did the freezing; false when it lost the
   * compare-and-set to a concurrent publish and is reporting that one. */
  readonly published: boolean;
}

export async function publishReport(
  deps: PublishDeps,
  ctx: PublishCtx,
  reportId: string,
): Promise<PublishOutcome> {
  const bundle = await loadReportBundle(deps.db, ctx.tenantId, reportId);
  if (bundle.report.frozenAt !== null && bundle.report.frozenHtmlS3Key !== null) {
    return {
      frozenAt: bundle.report.frozenAt,
      frozenKey: bundle.report.frozenHtmlS3Key,
      published: false,
    };
  }

  const built = contextFor(bundle);
  if (built.missingRequiredRoles.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Aguardando documento para: ${built.missingRequiredRoles.join(", ")}.`,
    });
  }

  const texts = slotTexts(bundle.content);
  const empty = bundle.slots
    .filter((slot) => (texts[slot.slug] ?? "").trim().length === 0)
    .map((slot) => slot.slug);
  if (empty.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Ainda sem texto: ${empty.join(", ")}. Gere ou escreva a prosa antes de publicar.`,
    });
  }

  // §12.12c. THE ALLOWED SET IS THE RENDER CONTEXT AND NOTHING ELSE — the
  // extraction data fields the roles bound plus the code-computed aggregates,
  // which is exactly what `buildReportContext` contains. Widening it with row
  // ids, timestamps or token counts would smuggle unrelated digits into the
  // universe and blunt the guard until it catches nothing.
  const violations = auditSlots(texts, harvestNumerals(built.context));
  if (violations.length > 0) {
    const detail = violations.map((v) => `slot "${v.slot}": "${v.token}"`).join("; ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `A prosa contém números sem fonte determinística e não pode ser publicada — ${detail}. ` +
        `Corrija o texto ou regenere a análise (§12.12).`,
    });
  }

  // §12.13. THE SECOND HARD GATE, and the one nothing downstream can
  // recompute: a refutation is another model's reading of this prose, not a
  // function of the data, so unlike the numeral guard above there is no way to
  // re-derive it at publish time. It is therefore read from `content_json`,
  // where the collector wrote it (api/collector/collect.ts).
  //
  // THE VERIFIER NEVER REWRITES (§12.13), so the only things that clear a
  // refutation are a human editing the slot — which retires the very prose the
  // verdict was about (api/render/report-content.ts) — or a fresh verify pass
  // that confirms it. Without that first rule this gate would be a report
  // wedged shut with no exit that did not involve a database.
  const contested = refutedSlots(bundle.content);
  if (contested.length > 0) {
    const detail = contested
      .map((slot) => {
        const first = slot.claims[0];
        const reason = first?.fundamento ?? first?.claim ?? "sem fundamento registrado";
        const more = slot.claims.length > 1 ? ` (+${String(slot.claims.length - 1)})` : "";
        return `slot "${slot.slug}": ${reason}${more}`;
      })
      .join("; ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `A verificação adversarial contestou afirmações na prosa e o relatório não pode ser ` +
        `publicado — ${detail}. Corrija o texto do slot (isso limpa a contestação) ou ` +
        `verifique novamente (§12.13).`,
    });
  }

  let html: string;
  try {
    // NO `missingSlotText` here. Publishing renders under the strict rule that
    // an unfilled slot THROWS — the emptiness check above already covered it,
    // and a placeholder reaching a client document is the failure this whole
    // path exists to prevent.
    html = renderTemplate(bundle.version.html, built.context, { slots: texts });
  } catch (err) {
    throw asRenderError(err);
  }

  const key = deps.frozenKey(ctx.tenantId, reportId);
  await deps.putFrozen(key, html);

  const frozenAt = new Date().toISOString();
  const updated = await deps.db
    .update(reports)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", {
        frozenHtmlS3Key: key,
        frozenAt,
      }),
    )
    .where(
      and(eq(reports.id, reportId), eq(reports.tenantId, ctx.tenantId), isNull(reports.frozenAt)),
    )
    .returning({ id: reports.id });

  if (updated.length === 0) {
    // Lost the race. This attempt's object is now unreferenced — the winner
    // stamped ITS OWN key — so drop it and report the winner's state. The
    // delete is best-effort: a publish that failed because a cleanup failed
    // would be a worse outcome for the same fact.
    try {
      await deps.deleteFrozen(key);
    } catch (err) {
      console.warn("[publish] orphan frozen object left behind", key, err);
    }
    const after = await loadReportBundle(deps.db, ctx.tenantId, reportId);
    if (after.report.frozenAt === null || after.report.frozenHtmlS3Key === null) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Não foi possível publicar o relatório. Tente novamente.",
      });
    }
    return {
      frozenAt: after.report.frozenAt,
      frozenKey: after.report.frozenHtmlS3Key,
      published: false,
    };
  }

  return { frozenAt, frozenKey: key, published: true };
}
