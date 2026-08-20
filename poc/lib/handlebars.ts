/**
 * §3.2 + §12.4 — the Handlebars subset, enforced rather than documented.
 *
 * Extraction values and AI prose are UNTRUSTED CONTENT. The template is authored
 * by a model too. So the environment is locked down before a template is ever
 * compiled:
 *
 *   - escaping ALWAYS on          -> `{{{triple}}}` is rejected at compile time
 *   - no partials                 -> `{{> x}}` rejected
 *   - no block/inline params, no subexpressions calling arbitrary helpers
 *   - helper allowlist == exactly: #each, #if, money, date, ai
 *   - prototype access off        -> `{{a.constructor}}` yields nothing
 *   - strict mode                 -> a typo'd path throws instead of rendering ""
 *
 * A rejected construct is a build-time error with a line number, not a silently
 * degraded document.
 */
import Handlebars from "handlebars";
import { formatCents, formatDate } from "./money.ts";

/** The four constructs of §3.2, plus the two formatters they need. */
const HELPER_ALLOWLIST = new Set(["each", "if", "money", "date", "ai"]);

export interface AiSlots {
  readonly [slug: string]: string;
}

export class TemplateViolation extends Error {
  public constructor(message: string) {
    super(`template rejeitado (§12.4): ${message}`);
    this.name = "TemplateViolation";
  }
}

/**
 * Static gate. Runs on the parsed AST before compilation, so a violation is
 * caught even in a branch the sample data never reaches.
 */
export function assertTemplateAllowed(source: string): void {
  const ast = Handlebars.parse(source);

  const visitStatements = (statements: hbs.AST.Statement[]): void => {
    for (const node of statements) visit(node);
  };

  const visit = (node: hbs.AST.Statement | hbs.AST.Program | null | undefined): void => {
    if (!node) return;
    switch (node.type) {
      case "Program":
        visitStatements((node as hbs.AST.Program).body);
        return;
      case "ContentStatement":
      case "CommentStatement":
        return;
      case "MustacheStatement": {
        const m = node as hbs.AST.MustacheStatement;
        if (!m.escaped) {
          throw new TemplateViolation(
            `{{{triple-stache}}} proibido (linha ${String(m.loc.start.line)}) — o escape de HTML é sempre obrigatório`,
          );
        }
        checkCallable(m.path, m.loc.start.line, m.params.length > 0);
        return;
      }
      case "BlockStatement": {
        const b = node as hbs.AST.BlockStatement;
        checkCallable(b.path, b.loc.start.line, true);
        visit(b.program);
        visit(b.inverse);
        return;
      }
      case "PartialStatement":
      case "PartialBlockStatement":
        throw new TemplateViolation(`partials proibidos (linha ${String(node.loc.start.line)})`);
      case "DecoratorBlock":
      case "Decorator":
        throw new TemplateViolation(`decorators proibidos (linha ${String(node.loc.start.line)})`);
      default:
        throw new TemplateViolation(`construção não suportada: ${node.type}`);
    }
  };

  const checkCallable = (path: hbs.AST.Expression, line: number, isCall: boolean): void => {
    if (path.type !== "PathExpression") {
      throw new TemplateViolation(`expressão não suportada na linha ${String(line)}`);
    }
    const p = path as hbs.AST.PathExpression;
    if (
      p.parts.some(
        (part) => part.startsWith("__") || part === "constructor" || part === "prototype",
      )
    ) {
      throw new TemplateViolation(`acesso a propriedade interna proibido na linha ${String(line)}`);
    }
    // A bare `{{a.b.c}}` is a data path, not a helper call — always fine.
    if (!isCall) return;
    const head = p.parts[0];
    if (head !== undefined && !HELPER_ALLOWLIST.has(head) && p.parts.length === 1) {
      throw new TemplateViolation(
        `helper "${head}" fora da allowlist (linha ${String(line)}) — permitidos: ${[...HELPER_ALLOWLIST].join(", ")}`,
      );
    }
  };

  visitStatements(ast.body);
}

export interface RenderOptions {
  readonly slots: AiSlots;
}

/** Compile + render under the locked-down environment. */
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
    if (typeof cents !== "number")
      throw new Error(`money: esperava cêntimos inteiros, recebeu ${typeof cents}`);
    return formatCents(cents);
  });

  env.registerHelper("date", (value: unknown): string => {
    if (typeof value !== "string")
      throw new Error(`date: esperava string dd/mm/aaaa, recebeu ${typeof value}`);
    return formatDate(value);
  });

  env.registerHelper("ai", (slug: unknown): string => {
    if (typeof slug !== "string") throw new Error("ai: slug deve ser literal string");
    const text = options.slots[slug];
    if (text === undefined) throw new Error(`ai: slot "${slug}" não preenchido pela análise`);
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
