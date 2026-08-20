// api/render/html-safety.test.ts
//
// An accept/reject TABLE, because that is what a denylist-shaped control
// actually needs: every rule stated as one row, so a rule that stops working
// fails on its own line instead of being covered by a neighbour.
//
// The ACCEPT half matters as much as the REJECT half. A scanner that refuses
// the print CSS, the inline logo, or an anchor to a section is a scanner
// someone will be asked to turn off.

import { describe, it, expect } from "vitest";
import { assertHtmlSafe, HtmlViolation } from "./html-safety";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const REJECTED: readonly (readonly [string, string])[] = [
  // --- elements that execute, navigate or embed --------------------------
  ["<script>alert(1)</script>", "script"],
  ["<SCRIPT SRC=https://evil.test/x.js></SCRIPT>", "uppercase script"],
  ["<iframe src='https://evil.test'></iframe>", "iframe"],
  ["<object data='x.swf'></object>", "object"],
  ["<embed src='x.swf'>", "embed"],
  ["<form action='https://evil.test'><input name=a></form>", "form"],
  ["<base href='https://evil.test/'>", "base"],
  ["<svg><use href='#x'/></svg>", "svg"],
  ["<math><mtext></mtext></math>", "math"],

  // --- event handlers ----------------------------------------------------
  ["<div onclick='alert(1)'>x</div>", "onclick"],
  ["<img src='/logo.png' ONERROR=alert(1)>", "uppercase onerror, unquoted"],
  ["<body onload=alert(1)>", "onload"],
  ["<p onmouseover = 'x'>t</p>", "spaced event attribute"],

  // --- dangerous URL schemes --------------------------------------------
  ["<a href='javascript:alert(1)'>x</a>", "javascript: href"],
  ["<a href='JaVaScRiPt:alert(1)'>x</a>", "mixed-case javascript:"],
  ["<a href='&#106;avascript:alert(1)'>x</a>", "entity-encoded javascript:"],
  ["<a href='java\tscript:alert(1)'>x</a>", "tab-split javascript:"],
  ["<a href='java&Tab;script:alert(1)'>x</a>", "entity-tab-split javascript:"],
  ["<img src='data:text/html;base64,PHNjcmlwdD4='>", "data:text/html"],
  ["<img src='data:image/svg+xml;base64,PHN2Zz4='>", "data:image/svg+xml"],
  ["<a href='http://plain.test/x'>x</a>", "http: downgrade"],
  ["<a href='vbscript:msgbox(1)'>x</a>", "vbscript:"],

  // --- navigation away from the printed document -------------------------
  ["<meta http-equiv='refresh' content='0;url=https://evil.test'>", "meta refresh"],

  // --- executable CSS ----------------------------------------------------
  ["<div style='background:url(javascript:alert(1))'>x</div>", "javascript: in style attr"],
  ["<style>a { behavior: url(x.htc); }</style>", "behavior in <style>"],
  ["<style>b { width: expression(alert(1)); }</style>", "expression() in <style>"],

  // --- expressions where escaping does not protect anything --------------
  ["<a href='{{link}}'>x</a>", "dynamic URL scheme"],
  ["<div {{atributos}}>x</div>", "expression as an attribute name"],
  ["<{{tag}}>x</{{tag}}>", "expression as a tag name"],
];

const ACCEPTED: readonly (readonly [string, string])[] = [
  ["<!doctype html><html><body><p>ok</p></body></html>", "an ordinary document"],
  [
    "<style>@page { size: A4; margin: 18mm 15mm; } .capa { break-after: page; }</style>",
    "the §5.4 print contract",
  ],
  ["<style>@media print { .no-print { display: none !important; } }</style>", "print overrides"],
  [`<img src="${PNG}" alt="logo">`, "an inline raster logo"],
  ['<a href="https://cliente.test/portal">portal</a>', "an https link"],
  ['<a href="mailto:contato@example.test">e-mail</a>', "mailto"],
  ['<a href="tel:+551140028922">telefone</a>', "tel"],
  ['<a href="#secao-2">ir para a secção</a>', "an in-document anchor"],
  ['<img src="/assets/logo.png">', "a relative path"],
  ["<p>{{nota.numero}}</p>", "an escaped data expression"],
  ['<a href="https://portal.test/{{nota.id}}">ver</a>', "a literal scheme with a dynamic tail"],
  ["<!-- <script>alert(1)</script> -->", "a commented-out script"],
  ['<td class="num">{{money totais.faturas.documento_cents}}</td>', "a money cell"],
  ["<div>a &lt; b &amp;&amp; c &gt; d</div>", "escaped comparison operators in text"],
  ["<p>Total: R$ 1.234,56 (23% > 20%)</p>", "a bare > in prose"],
];

describe("assertHtmlSafe — rejects", () => {
  it.each(REJECTED)("rejects %s (%s)", (source) => {
    expect(() => {
      assertHtmlSafe(source);
    }).toThrow(HtmlViolation);
  });

  it("names the line so the author can find it", () => {
    expect(() => {
      assertHtmlSafe("<p>ok</p>\n<p>ok</p>\n<div onclick='x'>bad</div>");
    }).toThrowError(/linha 3/u);
  });

  it("counts lines correctly past a multi-line expression", () => {
    // The mask preserves newlines precisely so this stays true.
    expect(() => {
      assertHtmlSafe("{{#each\n  faturas}}{{/each}}\n<script>x</script>");
    }).toThrowError(/linha 3/u);
  });

  it("speaks pt-BR, like every other refusal in the gate", () => {
    expect(() => {
      assertHtmlSafe("<script>x</script>");
    }).toThrowError(/Modelo rejeitado \(§12\.4\)/u);
  });
});

describe("assertHtmlSafe — accepts", () => {
  it.each(ACCEPTED)("accepts %s (%s)", (source) => {
    expect(() => {
      assertHtmlSafe(source);
    }).not.toThrow();
  });

  it("accepts a whole print-grade shell end to end", () => {
    expect(() => {
      assertHtmlSafe(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{meta.titulo}}</title>
    <style>
      @page { size: A4; margin: 18mm 15mm; }
      thead { display: table-header-group; }
      @media print { .no-print { display: none !important; } }
    </style>
  </head>
  <body>
    <img src="${PNG}" alt="logo" />
    <h1>{{meta.titulo}}</h1>
    <table>
      <tbody>
        {{#each faturas}}<tr><td>{{numero}}</td></tr>{{/each}}
      </tbody>
    </table>
    {{#if contrato}}<p>{{contrato.prazo}}</p>{{/if}}
    <div class="nota">{{ai "notas"}}</div>
  </body>
</html>`);
    }).not.toThrow();
  });
});
