# ReportFlow — POC (backend only, no UI)

Produces the actual client-facing report HTML from the real sample PDFs, so the
output can be approved before any UI work starts.

Everything here is written to be **ported into `api/lib` later**, not thrown
away: same strictness settings, same decisions, same module boundaries as
`docs/design/decisions.md`.

Nothing in `poc/` touches `api/`, `app/`, `drizzle/` or `shared/`. `poc/` is
excluded from the root `tsconfig.json` `include` and the root `eslint.config.js`
`files` allowlist, so `pnpm check`, `pnpm lint` and `pnpm validate` do not see
it and cannot be broken by it.

---

## Run it

```bash
pnpm tsx poc/extract.ts     # hop 1 — PDFs -> validated JSON   (cached, idempotent)
pnpm tsx poc/analyse.ts     # hop 2 — JSON -> pt-BR prose      (cached; --force to redo)
pnpm tsx poc/render.ts      # deterministic substitution -> two HTML files
pnpm tsx poc/verify.ts      # hop 3 — adversarial verify (§12.13) (cached, idempotent)
```

Output (all gitignored — it is derived from real client data):

| File                               | What                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `poc/out/relatorio-fiel.html`      | faithful copy of the reference layout, adapted to the Lisbon property     |
| `poc/out/relatorio-melhorado.html` | improved variant — KPIs first, reconciliation, provenance, upcoming dues  |
| `poc/out/extractions/*.json`       | one validated extraction per source PDF                                   |
| `poc/out/analysis.json`            | the `{{ai}}` slot texts                                                   |
| `poc/out/verify/*.verdict.json`    | one adversarial verdict file per source PDF, plus `analysis.verdict.json` |
| `poc/out/verify/SUMMARY.md`        | pt-BR roll-up: confirmed/refuted per doc, prose claims, exit status       |

**To get the PDF:** open the HTML in Chrome → Print → Save as PDF → A4, and
**untick "Headers and footers"**. That is §5.4: the print CSS is already
print-grade, so the PDF is exactly the HTML — no URL, no browser date. Both
files were verified this way (`--headless --print-to-pdf`): 3 and 5 A4 pages,
table headers repeating, no section split across a page break.

`extract.ts` **skips any PDF it has already extracted**. That is a billing guard,
not a speed trick — re-reading the same PDF must never bill twice (§7), which is
exactly what a human does when a read looks wrong. Delete the JSON to force a
re-read.

`verify.ts` is cached the same way, one `poc/out/verify/<file>.verdict.json` per
source; delete a verdict file to force a re-check of that one document.

---

## What is where

```
fields/          §3.1 — the Calibrate freeze
  spec.ts          FieldSpec + buildZodSchema()  ← Zod is built AT RUNTIME from the field list
  fatura.ts        field list, input_mode "text",   detect_hint
  contrato.ts      field list, input_mode "vision", detect_hint
lib/
  money.ts         verbatim currency string -> integer cents. No floats. Ever.
  handlebars.ts    §12.4 — strict subset, enforced on the AST before compiling
  report-model.ts  the deterministic half: extractions -> render context
  ai.ts            §6 registry + costFor() + transient-only retry
  providers/
    types.ts       the canonical { system, prompt, document, schema } job
    gemini.ts      the ONLY file that names a provider
template/
  declaration.ts   §3.2 — named roles + slot guidelines
  fiel.hbs         variant A
  melhorado.hbs    variant B
extract.ts  analyse.ts  render.ts  verify.ts
```

### The design decisions this POC actually exercises

- **§3.1 — field list is data, not a schema.** `buildZodSchema()` constructs the
  validator at runtime from the frozen list; `fieldsToPrompt()` and
  `fieldsToJsonSchema()` derive the prompt and the provider schema from that
  same list. One source, three consumers.
- **§3.1 — `input_mode` is a cost decision.** Not theoretical here: the faturas
  carry a text layer, the contract is a 4-page Ricoh scan whose text layer is
  **4 bytes**. Tier-1 substring detection is impossible for it and falls through
  exactly as §3.3/§12.2 describe.
- **§3.1 — per document TYPE, not per provider.** Same provider (House Living),
  two types, two completely different field lists.
- **§3.2 — roles, never indices.** `faturas` (required, many) and `contrato`
  (optional, one). An unfilled required role refuses to render, which is what
  makes _"aguardando: contrato"_ showable.
- **§6 — provider-agnostic by construction.** This POC survived a provider swap
  (Anthropic → Gemini) **mid-build**. It cost one directory: `lib/providers/`.
  The field lists, templates, money code, `extract.ts`, `analyse.ts` and
  `render.ts` were untouched.
- **§6.1 — structured output over citations.** `page` is a self-reported field.
- **§12.3 — hop 2 never reads a PDF.** `analyse.ts` sets no `documentPath`;
  the guarantee is an absence, not a promise.
- **§12.4 — Handlebars locked down.** `{{{triple}}}`, partials and any helper
  outside `#each / #if / money / date / ai` are rejected on the parsed AST
  _before_ compilation, so a violation in an unreached branch still fails.
- **§12.8 — recalibration invalidates.** The cache key is
  `<file>.rev<calibration_rev>.json`.
- **§12.13 — adversarial verify, a different model, never rewrites.**
  `verify.ts` hands the frozen field list to the SAME extraction template
  (§3.1's "one source, many consumers" extended to this hop) so the verifier
  knows which fields are mandated NORMALIZATIONS (dd/mm/yyyy dates, an IBAN
  with spaces stripped, a wrapped PDF cell condensed to one string, a
  paraphrase/short title) rather than treating every one of them as a
  discrepancy. `valor_documento` / `fundamento` record what the verifier saw;
  the extraction/analysis file is never touched.
- **§5.4 — browser print.** `@page A4 / 18mm 15mm`, `.capa`, `.secao`,
  `thead table-header-group`, `.no-print`. Zero PDF dependencies.

### Money

Currency is a **string on the page** and an **integer in the code**. The model
returns `"1.234,56 €"` verbatim; `parseEuroToCents` turns it into `123456`; every
total is an integer sum. No float touches a monetary value at any point.

`render.ts` asserts this rather than claiming it — 37 checks, including that all
13 invoice totals appear **byte-identical** in both HTML files, that
`base + IVA == total` to the cent, and that no PII the field list never extracted
can be present.

---

## Cost

Live, all 14 documents plus the analysis: **$0.25**.

| Hop         | Model                   | Tokens                 | Cost    |
| ----------- | ----------------------- | ---------------------- | ------- |
| Extract ×14 | `gemini-3.5-flash`      | 33 885 in / 22 152 out | $0.2502 |
| Analyse ×1  | `gemini-3.5-flash-lite` | 6 613 in / 473 out     | $0.0032 |

Model ids and rates for extract/analyse are taken from
`smartstocke/api/billing/cost-of-goods.ts`, not invented. `costUsd()` throws on
an unpriced model — _unpriced is not free_. Re-running the scripts costs **$0**
because both hops are cached.

---

## Verify (§12.13)

```bash
pnpm tsx poc/verify.ts               # all 14 documents + the analysis
pnpm tsx poc/verify.ts FT_C2025_141.pdf   # one document
pnpm tsx poc/verify.ts --no-analysis      # extraction verify only
pnpm tsx poc/verify.ts --no-extractions   # analysis verify only
```

Two adversarial checks, run by a model DIFFERENT from the one that produced
the thing being checked:

1. **Extraction verify** — the source PDF + the cached extraction JSON go to
   the verifier with a refute-this prompt ("try to refute each field"). Each
   field of each of the 13 faturas + 1 contrato gets a verdict: `confirmado` /
   `refutado` / `ilegivel`.
2. **Analysis verify** — the `{{ai}}` slot texts from `poc/out/analysis.json`
   plus the raw extraction DATA (never a PDF — the same §12.3 guarantee hop 2
   already gives, held a second time) go to the verifier, which decomposes
   each slot into discrete factual claims and tries to refute each one.

The verifier **never rewrites a value**. A `refutado` verdict is a flag for a
human (`revisar`), not a correction — `valor_documento` / `fundamento` record
what the verifier saw; the file being checked is never touched. Output:
`poc/out/verify/<file>.verdict.json` per document, `analysis.verdict.json` for
the prose, and a pt-BR roll-up at `poc/out/verify/SUMMARY.md`. `verify.ts`
exits non-zero (and prints exactly which fields/claims) whenever anything
comes back `refutado`. Cached the same way as `extract.ts` — an existing
verdict file is skipped, not re-checked; delete it to force a re-check.

**Model.** Only a Google key exists today, so this cannot be cross-provider
yet — it is a different tier and generation instead: `gemini-3.1-pro-preview`,
pinned in `lib/ai.ts` as `MODEL_VERIFY`. There is **no `gemini-3.5-pro`** —
checked live against Gemini's `ListModels` before wiring this up; the "pro"
tier skipped a 3.5 release entirely, so `gemini-3.1-pro-preview` is the
nearest real pro-tier model to the 3.5-flash family `MODEL_EXTRACT` /
`MODEL_ANALYSE` use. It is **not** in smartstocke's real
`cost-of-goods.ts` (that table only ever priced the flash family) — rather
than leave it unpriced (which would make `costUsd()` throw and block every
call), `lib/ai.ts` adds an estimated rate (~2x flash, the same ratio flash/
flash-lite already show), clearly commented as a placeholder pending a real
rate-card entry. The registry (`getAdapter()`) already supports a second
provider; swapping `MODEL_VERIFY` to it is the entire future migration.

### Live result

All 14 documents, first corrected pass: **$0.89** (54 022 in / 39 858 out
tokens across 15 calls — 14 extraction verifies + 1 analysis verify).

| Check                     | Fields/claims checked | Confirmado | Refutado | Ilegível |
| ------------------------- | --------------------- | ---------- | -------- | -------- |
| Extraction ×14 (all docs) | 312                   | **312**    | **0**    | 0        |
| Analysis (2 slots)        | 20                    | 15         | 4        | 1        |

**Extraction verify: 312/312 fields confirmed, zero refutations**, across all
13 faturas and the contract. The first live attempt was not this clean — see
"a false-positive lesson" below.

**Analysis verify: 4 of 20 decomposed claims came back `refutado`, 1
`ilegivel`.** All 5 share one root cause, not five different problems: they
reference the deterministic context `report-model.ts`'s `buildContext()`
computes (the label "cláusula Quarta", the semiannual due-date schedule
derived from the contract's periodicity) — `analyse.ts` is given that computed
context and writes prose from it, but per §12.13 the verifier is given only
the raw extraction JSON, which does not contain those derived facts. The
verifier is correctly saying "I cannot confirm this from what I was handed" —
that is not the same as "this is wrong." Cross-checked by hand against
`report-model.ts`: every one of the 5 flagged claims is accurate. `verify.ts`
still exits non-zero and still lists them for `revisar`, because a human
should make that call, not this script — but it is worth knowing, before
reading the `revisar` list as a defect count, that this batch is a scope
artifact of "extraction data only," not a caught error.

### A false-positive lesson from the first live attempt

The first attempt at this prompt refuted **7 of 13 faturas** (always
`itens[0].descricao`) and produced an **invalid, truncated** response for the
contract. Both were the same mistake: the verifier was never told that
`fields/fatura.ts` explicitly asks for a wrapped, multi-line PDF cell
"condensed... numa só string" and that `fields/contrato.ts`'s
`obrigacoes_principais.titulo/detalhe` are explicitly a "rótulo curto" and a
paraphrase, not a verbatim quote. Compared against the raw document text
literally, every one of those MANDATED transformations reads as a
discrepancy — the fatura refutations were pure PDF-line-wrap whitespace, and
the contract's were paraphrase fields compared against a full clause quote
(worsened by a `maxTokens: 8192` cap that then truncated the contract's long
response into invalid JSON). The fix — handing the verifier the same frozen
field list `fields/spec.ts`'s `fieldsToPrompt()` gives the extractor, plus
explicit normalization/whitespace guidance, plus a `32768`/`16384` token
budget — is what produced the clean 312/312 rerun above. Kept here rather than
silently corrected because it is the whole point of §12.13's own caution: a
verifier that does not understand the contract it is checking against
produces confident-sounding noise, not signal.

---

## Extraction quality (measured, not asserted)

Every fatura was independently transcribed by hand from its text layer before
the live run, and kept in `poc/out/extractions-mock/`. Comparing the live
Gemini extraction against that transcription:

**247 / 247 non-descriptive values identical** — every amount, date, invoice
number, NIF and IBAN.

One real miss on the first pass, worth knowing about:

- On one of thirteen invoices the model returned the **entire address block** as
  `cliente_nome`. Schema-**valid** (a non-empty string) but semantically wrong —
  Zod cannot catch this, which is exactly why §3.1 keeps a human-confirmed
  golden fixture beside the field list. Fixed by tightening that field's
  `description`; re-extracting that one file cost $0.014.
- The contract initially **failed** validation: it prints the honorarium with a
  space as thousands separator and the currency spelled out (`euros`) — normal in
  a Portuguese legal document — while the invoices use a dot and the `€` sign.
  Same amount, two typographies. The model returned it verbatim as instructed, so
  the model was right and **the field list was wrong**. It was parked as
  `.invalid.json` for
  `revisar` instead of being silently coerced, which is §4.2 behaving correctly.
  The `money` type now accepts both typographies and normalises to the same cents.

---

## What the report found in the real data

Computed deterministically in `report-model.ts` — no model opinion involved.
Figures are deliberately **not reproduced here**: this file is committed, the
sample data is not. Run `render.ts` and read the output.

1. Both House Sitting invoices match the contract's semiannual retribution
   clause **exactly, to the cent**.
2. **Two semiannual periods have no corresponding invoice** in the sample.
   Surfaced as its own "próximos vencimentos" section with a badge.
3. The invoices' IBAN **differs from the account named in cláusula Quarta**.
   Flagged for confirmation before any payment.
4. One invoice **predates the contract** — services rendered before the term
   began.
5. One invoice (utilities installation) is the only **non-recurring** item, and
   is badged so it does not pollute period-over-period comparison.

Items 2, 3 and 4 are the kind of thing a human reading thirteen PDFs in sequence
is most likely to miss, and they are exactly what a report is for.

## Maps to which future issue

| POC file                  | Future home                                             | Issue shape                                                                         |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `fields/spec.ts`          | `api/lib/extract/field-schema.ts`                       | Calibrate: build Zod + prompt + provider schema from `extract_fields` rows          |
| `fields/*.ts`             | `extract_templates` / `extract_fields` rows             | Calibrate UI: AI proposes → human edits → freeze                                    |
| `lib/providers/*`         | `relay/src/providers/*`                                 | Relay adapter + `CHANNELS` registry line + SSM param                                |
| `lib/ai.ts` (`costUsd`)   | `api/billing/cost-of-goods.ts`                          | Port from smartstocke; add rows before billing (§10.5)                              |
| `lib/money.ts`            | `shared/money.ts`                                       | Used by both the renderer and the review screen                                     |
| `lib/handlebars.ts`       | `api/lib/render/handlebars.ts`                          | §12.4 hardening + sandboxed authoring `<iframe>`                                    |
| `lib/report-model.ts`     | `api/lib/render/context.ts`                             | The deterministic half; the only place numbers are derived                          |
| `template/declaration.ts` | `outbound_template_versions.inputs_json` / `slots_json` | Role gating → _"aguardando: contrato"_ state                                        |
| `template/*.hbs`          | `outbound_template_versions.html`                       | System templates authored by platform admin (`lov` scope)                           |
| `extract.ts`              | hop 1 job + collector                                   | S3 outbox, `unique(s3_key, calibration_rev)`, `revisar` on invalid                  |
| `analyse.ts`              | hop 2 job                                               | Per-slot `edited` flag, regeneration skips edited slots (§5.2)                      |
| `render.ts`               | draft render + publish                                  | Freeze HTML to S3 on publish (§5.1)                                                 |
| `verify.ts`               | hop 3 job (§12.13)                                      | `report_verify:{provider}:{model}:{refKey}` charge key, `revisar` on any `refutado` |

### Not covered by this POC

- Tenancy, auth, `TABLE_SCOPE`, persistence — no DB is touched.
- S3, the relay, the collector, the job state machine (§12.1).
- Page-1 text extraction for tier-1 detection (§12.2) — `detectType()` uses the
  filename; the library spike is still open.
- A second provider key for the verify hop — `MODEL_VERIFY` is same-family,
  different-tier (`gemini-3.1-pro-preview`) rather than cross-provider (§12.13).
- Persisting `report-model.ts`'s computed context (`ctx.verificacoes`,
  `ctx.vencimentos`) alongside `analysis.json` — right now it only exists
  ephemerally inside `analyse.ts`'s run, so `verify.ts`'s analysis check (raw
  extraction data only, per spec) cannot confirm prose claims that cite it.
- `ai_charges` rows / idempotency keys — cost is computed and printed, not billed.
- Template authoring UI, versioning, per-slot editing UI.
