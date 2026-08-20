// api/render/handlebars.ts
//
// §3.2 + §12.4 — the Handlebars subset, enforced rather than documented.
// Ported from poc/lib/handlebars.ts (proven), tightened where the POC's gate
// was permissive (see "TIGHTENED" below).
//
// WHY THIS LIVES IN api/ AND NOT shared/.
// The authoring preview renders SERVER-SIDE, through
// `outbound.preview`, and the browser only ever receives the finished HTML to
// drop into a sandboxed `<iframe srcdoc>`. Two things follow, and both were
// the reason for the placement:
//   1. Handlebars never ships to the client — a compiler in the bundle is a
//      compiler an attacker can call with a template of their choosing, and
//      the whole point of §12.4 is that only THIS gate compiles anything.
//   2. Preview and render are the SAME engine by construction. A client-side
//      preview is a second implementation, and a second implementation of
//      "what the document will say" is one that can disagree with the
//      document.
// shared/ is for code both halves genuinely import. `app/` imports none of
// this, so putting it there would only widen the bundle and the blast radius.
//
// Extraction values and AI prose are UNTRUSTED CONTENT. The template is
// authored by a model too. So the environment is locked down before a template
// is ever compiled:
//
//   - escaping ALWAYS on          -> `{{{triple}}}` is rejected at compile time
//   - no partials                 -> `{{> x}}` rejected
//   - no decorators, no block params, no subexpressions, no hash arguments
//   - helper allowlist == exactly: #each, #if, money, date, ai
//   - prototype access off        -> `{{a.constructor}}` yields nothing
//   - strict mode                 -> a typo'd path throws instead of rendering ""
//
// A rejected construct is a save-time error with a line number and a pt-BR
// message, not a silently degraded document.

import Handlebars from "handlebars";
import { assertHtmlSafe } from "./html-safety";
import { formatCents, formatDate } from "./money";

/** The four constructs of §3.2, plus the two formatters they need. */
const HELPER_ALLOWLIST = new Set(["each", "if", "money", "date", "ai"]);

export interface AiSlots {
  readonly [slug: string]: string;
}

export class TemplateViolation extends Error {
  public override readonly name = "TemplateViolation";
  public constructor(message: string) {
    super(`Modelo rejeitado (§12.4): ${message}`);
  }
}

// The AST shapes this gate needs, declared LOCALLY rather than reached for
// through handlebars' global `hbs` namespace. Two reasons: the global is
// invisible to `no-undef` (eslint's core rule, on for every .ts here), and the
// gate only cares about a handful of structural fields — spelling them out
// documents exactly which parts of the parse this security check depends on.
// `hash` and `blockParams` are optional here and non-optional in handlebars'
// own typings, because the parser omits them when there are none.

interface AstNode {
  readonly type: string;
  readonly loc: { readonly start: { readonly line: number } };
}
interface AstPath extends AstNode {
  readonly parts: readonly string[];
  readonly original: string;
}
interface AstStringLiteral extends AstNode {
  readonly value: string;
}
interface AstHash extends AstNode {
  readonly pairs: readonly unknown[];
}
interface AstProgram extends AstNode {
  readonly body: readonly AstNode[];
  readonly blockParams?: readonly string[];
}
interface AstCall extends AstNode {
  readonly path: AstNode;
  readonly params: readonly AstNode[];
  readonly hash?: AstHash;
  readonly escaped?: boolean;
  readonly program?: AstProgram;
  readonly inverse?: AstProgram;
}

function lineOf(node: AstNode): string {
  return String(node.loc.start.line);
}

/**
 * TIGHTENED vs the POC: params are inspected too.
 *
 * The POC gate checked the CALLEE and left `{{money (lookup a b)}}` and
 * `{{#if x as |y|}}` to `knownHelpersOnly` at compile time. That works, but it
 * moves the refusal from a line-numbered save-time error to a compiler error
 * whose message is not ours — and it leaves the AST scan (`scanAiSlots`)
 * looking at shapes it has no rule for. Both are refused here instead.
 */
function checkExpression(expr: AstNode, line: string): void {
  if (expr.type === "SubExpression") {
    throw new TemplateViolation(
      `subexpressões proibidas (linha ${line}) — apenas caminhos simples e literais são aceites`,
    );
  }
  if (expr.type !== "PathExpression") {
    return; // string/number/boolean/undefined/null literals are inert
  }
  const parts = (expr as AstPath).parts;
  if (
    parts.some((part) => part.startsWith("__") || part === "constructor" || part === "prototype")
  ) {
    throw new TemplateViolation(`acesso a propriedade interna proibido na linha ${line}`);
  }
}

/** The callee half. `isCall` is true for blocks and for any mustache with
 * params — a bare `{{a.b.c}}` is a data path, not a helper call. */
function checkCallable(path: AstNode, line: string, isCall: boolean): void {
  if (path.type !== "PathExpression") {
    throw new TemplateViolation(`expressão não suportada na linha ${line}`);
  }
  const p = path as AstPath;
  checkExpression(p, line);
  if (!isCall) {
    return;
  }
  const head = p.parts[0];
  if (p.parts.length !== 1 || head === undefined || !HELPER_ALLOWLIST.has(head)) {
    const shown = p.parts.length > 0 ? p.parts.join(".") : p.original;
    throw new TemplateViolation(
      `helper "${shown}" fora da allowlist (linha ${line}) — permitidos: ${[...HELPER_ALLOWLIST].join(", ")}`,
    );
  }
}

/** The helper name of an already-checked callee. */
function helperName(path: AstNode): string {
  return (path as AstPath).parts[0] ?? "";
}

/** Checks the ARGUMENT half and, for `ai`, returns the slug literal. Returning
 * it is what lets `scanAiSlots` share this walk instead of re-deriving which
 * mustaches are slots. */
function checkCallShape(node: AstCall, line: string): string | null {
  const hash = node.hash;
  if (hash !== undefined && hash.pairs.length > 0) {
    throw new TemplateViolation(`argumentos nomeados proibidos (linha ${line})`);
  }
  for (const param of node.params) {
    checkExpression(param, line);
  }
  if (helperName(node.path) !== "ai") {
    return null;
  }
  const first = node.params[0];
  if (node.params.length !== 1 || first?.type !== "StringLiteral") {
    throw new TemplateViolation(
      `{{ai "slug"}} exige exatamente um slug entre aspas (linha ${line})`,
    );
  }
  return (first as AstStringLiteral).value;
}

type SlotSink = (slug: string, line: string) => void;

function visitMustache(node: AstCall, sink: SlotSink | undefined): void {
  const line = lineOf(node);
  if (node.escaped !== true) {
    throw new TemplateViolation(
      `{{{triple-stache}}} proibido (linha ${line}) — o escape de HTML é sempre obrigatório`,
    );
  }
  const isCall = node.params.length > 0;
  checkCallable(node.path, line, isCall);
  if (!isCall) {
    return;
  }
  const slug = checkCallShape(node, line);
  if (slug !== null && sink !== undefined) {
    sink(slug, line);
  }
}

function visitBlock(node: AstCall, visit: (n: AstNode | undefined) => void): void {
  const line = lineOf(node);
  checkCallable(node.path, line, true);
  checkCallShape(node, line);
  visit(node.program);
  visit(node.inverse);
}

/**
 * Static gate. Runs on the parsed AST before compilation, so a violation is
 * caught even in a branch the sample data never reaches.
 *
 * `onAiSlot` is how `scanAiSlots` rides the same walk: the slot list and the
 * gate must never disagree about what an `{{ai}}` call is, and they cannot
 * disagree if there is one walk.
 */
function walkTemplate(source: string, onAiSlot?: SlotSink): void {
  // THE TEMPLATE'S OWN MARKUP, before its expressions. The AST models the
  // mustaches and treats everything between them as an opaque
  // ContentStatement, which the engine then copies to the output byte for
  // byte — so `<script>` in the textarea is `<script>` in the printed
  // document, and the print window is same-origin with scripts live
  // (app/src/features/outbound/print.ts). api/render/html-safety.ts owns
  // those bytes; this walk owns the expressions.
  assertHtmlSafe(source);

  let ast: AstProgram;
  try {
    ast = Handlebars.parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TemplateViolation(`não foi possível interpretar o modelo — ${message}`);
  }

  const visit = (node: AstNode | undefined): void => {
    if (node === undefined) {
      return;
    }
    switch (node.type) {
      case "Program": {
        const program = node as AstProgram;
        const blockParams = program.blockParams;
        if (blockParams !== undefined && blockParams.length > 0) {
          throw new TemplateViolation("parâmetros de bloco (as |x|) proibidos");
        }
        for (const child of program.body) {
          visit(child);
        }
        return;
      }
      case "ContentStatement":
      case "CommentStatement":
        return;
      case "MustacheStatement":
        visitMustache(node as AstCall, onAiSlot);
        return;
      case "BlockStatement":
        visitBlock(node as AstCall, visit);
        return;
      case "PartialStatement":
      case "PartialBlockStatement":
        throw new TemplateViolation(`partials proibidos (linha ${lineOf(node)})`);
      case "DecoratorBlock":
      case "Decorator":
        throw new TemplateViolation(`decorators proibidos (linha ${lineOf(node)})`);
      default:
        throw new TemplateViolation(`construção não suportada: ${node.type}`);
    }
  };

  visit(ast);
}

/** The gate on its own. Throws `TemplateViolation` on the first violation. */
export function assertTemplateAllowed(source: string): void {
  walkTemplate(source);
}

/**
 * Every `{{ai "slug"}}` in the source, in document order, deduplicated.
 *
 * This is what `saveVersion` stores as `slots_json` — the template DECLARES
 * its prose slots by using them, so a slot can never exist in the declaration
 * and not in the HTML (a slot hop 2 pays to write and nothing renders) or the
 * other way round (a hole the analysis was never asked to fill).
 *
 * Runs the full gate as it goes: scanning a template nobody has validated
 * would report slots for a template that can never render.
 */
export function scanAiSlots(source: string): string[] {
  const seen: string[] = [];
  walkTemplate(source, (slug, line) => {
    if (slug.length === 0) {
      throw new TemplateViolation(`slug de {{ai}} vazio (linha ${line})`);
    }
    if (!seen.includes(slug)) {
      seen.push(slug);
    }
  });
  return seen;
}

export interface RenderOptions {
  readonly slots: AiSlots;
  /** Text used for a declared slot the analysis has not written yet. Draft
   * previews pass a visible placeholder; publish passes nothing, because a
   * report whose prose is a placeholder is not a report (§5.1). */
  readonly missingSlotText?: (slug: string) => string;
}

/**
 * Compile + render under the locked-down environment.
 *
 * `assertTemplateAllowed` runs HERE too, not only at save time, and that is
 * the BELT rather than a redundancy: `outbound_template_versions` is immutable
 * (§5.3), so a row written before a rule existed can never be corrected in
 * place. The render path is the last place left to refuse it.
 */
export function renderTemplate(
  source: string,
  data: Record<string, unknown>,
  options: RenderOptions,
): string {
  assertTemplateAllowed(source);

  // A fresh isolated environment per render: no global helper registry to
  // poison, nothing inherited from another tenant's template.
  const env = Handlebars.create();

  env.registerHelper("money", (cents: unknown): string => {
    if (typeof cents !== "number") {
      throw new Error(`money: esperava cêntimos inteiros, recebeu ${typeof cents}`);
    }
    return formatCents(cents);
  });

  env.registerHelper("date", (value: unknown): string => {
    if (typeof value !== "string") {
      throw new Error(`date: esperava string dd/mm/aaaa, recebeu ${typeof value}`);
    }
    return formatDate(value);
  });

  env.registerHelper("ai", (slug: unknown): string => {
    if (typeof slug !== "string") {
      throw new Error("ai: slug deve ser literal string");
    }
    const text = options.slots[slug];
    if (text === undefined) {
      if (options.missingSlotText !== undefined) {
        return options.missingSlotText(slug);
      }
      throw new Error(`ai: slot "${slug}" não preenchido pela análise`);
    }
    return text; // returned as a String, so Handlebars escapes it. Untrusted prose.
  });

  const compiled = env.compile(source, {
    strict: true, // unknown path -> throw, never render ""
    noEscape: false,
    knownHelpers: { each: true, if: true, money: true, date: true, ai: true },
    knownHelpersOnly: true,
    preventIndent: true,
  });

  return compiled(data, {
    allowProtoPropertiesByDefault: false,
    allowProtoMethodsByDefault: false,
    allowedProtoProperties: {},
    allowedProtoMethods: {},
  });
}
