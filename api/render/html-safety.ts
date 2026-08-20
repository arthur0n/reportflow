// api/render/html-safety.ts
//
// §12.4, second half — THE TEMPLATE'S OWN MARKUP.
//
// Handlebars escaping protects the DATA that flows into a template. It does
// nothing about the template itself: `<script>alert(1)</script>` written
// straight into the textarea is a ContentStatement, and the engine copies
// ContentStatements to the output byte for byte. That matters because the
// print path (app/src/features/outbound/print.ts) writes the rendered HTML
// into a real window with `document.write` — same-origin, scripts live. The
// preview `<iframe sandbox="">` contains it; the print window does not, and
// cannot: a sandbox that permits the print dialog permits scripts.
//
// So the markup is made PROVABLY INERT at the gate, and the print path stays
// as it is. Templates are authored by a MODEL and saved by a human who is
// reviewing prose, not auditing HTML — "the author would have noticed" is not
// a control.
//
// WHY A SCANNER AND NOT A SANITIZER DEPENDENCY.
// A sanitizer parses, mutates and re-serialises. Three costs we refuse here:
// it is a dependency in a Lambda bundle that must survive `sam build`; a
// SILENT mutation turns "your template is unsafe" into "your template quietly
// renders differently", which is the opposite of §12.4's line-numbered
// refusal; and mutation means the stored source and the rendered output are
// different documents, so the fixture dry run stops proving anything about
// what ships. This scanner REJECTS. Nothing is ever rewritten.
//
// THE TRADEOFF, STATED. A regex scanner is not an HTML parser and cannot be.
// It is deliberately CONSERVATIVE: anything it cannot read as obviously inert
// is refused. It over-rejects (a commented-out `<script>` inside a conditional
// comment, a tag name spelled by an expression) and that is the correct
// direction for a control whose failure mode is executing attacker markup in
// a same-origin window. The gate already owns the AST walk; this owns the
// bytes between the mustaches, which the AST deliberately does not model.

/** Masking sentinel. Occupies the exact byte span of a `{{…}}` expression so
 * every offset — and therefore every line number — stays true, while the
 * scanner can still SEE that a value was dynamic. */
const EXPR = "\u0001";

export class HtmlViolation extends Error {
  public override readonly name = "HtmlViolation";
  public constructor(message: string) {
    super(`Modelo rejeitado (§12.4): ${message}`);
  }
}

/**
 * Elements that can execute, navigate, or embed. `<style>` is deliberately NOT
 * here: the print contract IS a stylesheet (§5.4), so a template without one
 * is not a template. Its CONTENT is scanned separately, below.
 *
 * `<svg>` and `<math>` are refused even though a logo is a plausible use: both
 * are foreign-content parsers with their own script surface and a long history
 * of mutation-XSS, and `<img src="data:image/png…">` covers the logo case
 * without any of it.
 */
const DENIED_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "base",
  "svg",
  "math",
  "portal",
  "noscript",
]);

/** Attributes whose value the browser resolves as a URL. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "ping",
  "cite",
  "longdesc",
  "usemap",
  "xlink:href",
  "profile",
  "manifest",
]);

/**
 * Schemes a template may name literally.
 *
 * DECIDED: `https`, `mailto`, `tel`, plus `data:` restricted to a raster image
 * media type. Everything relative (`/x`, `x.png`, `#secao`, `?q=1`) is fine —
 * it cannot introduce a new origin or a script. `http:` is refused: a printed
 * report is a document a client keeps, and a plaintext subresource in one is
 * a downgrade nobody chose. `tel:` is here because a footer phone number is an
 * ordinary thing to want and the scheme has no script surface.
 */
const ALLOWED_SCHEMES = new Set(["https", "mailto", "tel"]);

/** `data:` is allowed ONLY for a raster image — the inline-logo case. NOT
 * `image/svg+xml`: an SVG is a document, not a picture, and `data:` URLs are
 * the one place where "it is only an image" stops being true. */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);/iu;

const NAMED_ENTITIES: Record<string, string> = {
  tab: "\t",
  newline: "\n",
  colon: ":",
  sol: "/",
  NewLine: "\n",
  Tab: "\t",
};

/**
 * Enough entity decoding to defeat `&#106;avascript:` and `java&Tab;script:`.
 *
 * NOT a general HTML entity decoder, and it does not need to be: it runs only
 * on a URL-bearing attribute value, and the single question being asked is
 * "what scheme does the browser see". Decoding more would widen the surface
 * of this function for no gain; decoding less is how every `javascript:`
 * bypass in the wild has worked.
 */
function decodeForSchemeCheck(raw: string): string {
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/giu, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/gu, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/giu, (m, name: string) => NAMED_ENTITIES[name] ?? m);
  // Browsers strip C0 controls and whitespace while resolving a scheme, which
  // is what makes `java&#9;script:` work in the wild. Done as a fold rather
  // than a character-class regex because a literal control character in a
  // regex is exactly what `no-control-regex` exists to catch, and silencing
  // that rule to write this one line would be the wrong trade.
  let out = "";
  for (const char of decoded) {
    if ((char.codePointAt(0) ?? 0) > 0x20) {
      out += char;
    }
  }
  return out;
}

function lineAt(source: string, index: number): string {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return String(line);
}

/**
 * Blanks out every `{{…}}` and every `<!-- … -->` while preserving length and
 * newlines, so the scanner sees markup STRUCTURE only.
 *
 * Comments are masked rather than scanned: a commented-out `<script>` is inert
 * in every browser still shipping (conditional comments died with IE), and
 * scanning inside them would reject templates for markup that never renders.
 * Masking keeps the offsets honest, which is what the line numbers ride on.
 */
function maskDynamicAndComments(source: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/gu, EXPR);
  return source
    .replace(/<!--[\s\S]*?-->/gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}/gu, blank);
}

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/gu;
const ATTR_RE = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/gu;

function checkUrlValue(attr: string, rawValue: string, tag: string, line: string): void {
  if (rawValue.includes(EXPR)) {
    const trimmed = rawValue.trimStart();
    if (trimmed.startsWith(EXPR)) {
      // `href="{{x}}"` — the SCHEME itself would come from data, and escaping
      // does not touch `javascript:alert(1)` because it contains nothing to
      // escape. A literal safe prefix (`https://host/{{id}}`) is fine.
      throw new HtmlViolation(
        `${attr} de <${tag}> começa com uma expressão (linha ${line}) — o esquema da URL tem de ser ` +
          `literal (por exemplo https://…/{{id}})`,
      );
    }
  }
  const value = decodeForSchemeCheck(rawValue.replace(new RegExp(EXPR, "gu"), ""));
  if (value.length === 0) {
    return;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(value);
  if (scheme === null) {
    return; // relative, #anchor, ?query, //host — no new script surface
  }
  const name = (scheme[1] ?? "").toLowerCase();
  if (ALLOWED_SCHEMES.has(name)) {
    return;
  }
  if (name === "data" && DATA_IMAGE_RE.test(value)) {
    return;
  }
  throw new HtmlViolation(
    `esquema "${name}:" proibido em ${attr} de <${tag}> (linha ${line}) — permitidos: ` +
      `https, mailto, tel, caminhos relativos e data:image/* (exceto SVG)`,
  );
}

/** An expression sitting in the attribute REGION but outside a quoted value —
 * `<div {{atributos}}>` — would let escaped data become an attribute NAME, and
 * `onclick=x` needs no escaping at all. */
function assertNoBareExpression(attrs: string, tag: string, line: string): void {
  let quote: string | null = null;
  for (const char of attrs) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === EXPR) {
      throw new HtmlViolation(
        `expressão na abertura de <${tag}> (linha ${line}) — uma expressão só pode aparecer no ` +
          `VALOR de um atributo, entre aspas`,
      );
    }
  }
}

function checkAttributes(tag: string, attrs: string, line: string): void {
  assertNoBareExpression(attrs, tag, line);
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let sawHttpEquiv = false;
  while ((match = ATTR_RE.exec(attrs)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name.startsWith("on") && name.length > 2) {
      throw new HtmlViolation(
        `atributo de evento "${name}" proibido em <${tag}> (linha ${line}) — o documento impresso ` +
          `não executa scripts`,
      );
    }
    if (name === "http-equiv") {
      sawHttpEquiv = true;
    }
    if (name === "style" && /javascript:|expression\s*\(/iu.test(value)) {
      throw new HtmlViolation(`CSS executável em style de <${tag}> (linha ${line})`);
    }
    if (URL_ATTRIBUTES.has(name)) {
      checkUrlValue(name, value, tag, line);
    }
  }
  if (tag === "meta" && sawHttpEquiv) {
    // `<meta http-equiv="refresh" content="0;url=…">` navigates the print
    // window away from the document being printed.
    throw new HtmlViolation(`<meta http-equiv> proibido (linha ${line})`);
  }
}

/** `<style>` bodies are allowed (the print contract is CSS) but not executable. */
function checkStyleBodies(masked: string, source: string): void {
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const body = match[1] ?? "";
    if (/javascript:|expression\s*\(|behavior\s*:|-moz-binding/iu.test(body)) {
      throw new HtmlViolation(
        `CSS executável dentro de <style> (linha ${lineAt(source, match.index)})`,
      );
    }
  }
}

/**
 * Refuses any template whose own markup could execute, navigate or embed.
 *
 * Runs at SAVE time (the gate) and again inside `renderTemplate` — the belt.
 * The belt is not redundant: `outbound_template_versions` is immutable, so a
 * row written before this check existed can never be corrected in place, and
 * the render path is the only place left to stop it.
 */
export function assertHtmlSafe(source: string): void {
  const masked = maskDynamicAndComments(source);

  // A tag whose NAME is an expression never matches TAG_RE, so it would slip
  // past every rule below. Caught explicitly rather than by omission.
  const dynamicTag = new RegExp(`<\\/?${EXPR}`, "u").exec(masked);
  if (dynamicTag !== null) {
    throw new HtmlViolation(
      `nome de tag vindo de uma expressão (linha ${lineAt(source, dynamicTag.index)}) — proibido`,
    );
  }

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(masked)) !== null) {
    const tag = (match[1] ?? "").toLowerCase();
    const line = lineAt(source, match.index);
    if (DENIED_ELEMENTS.has(tag)) {
      throw new HtmlViolation(
        `<${tag}> proibido (linha ${line}) — o relatório impresso é um documento inerte`,
      );
    }
    checkAttributes(tag, match[2] ?? "", line);
  }

  checkStyleBodies(masked, source);
}
