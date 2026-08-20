// api/render/handlebars.test.ts
//
// The §12.4 gate is a SECURITY boundary, so what is under test is mostly what
// it REFUSES. The template is authored by a model and filled with extraction
// values and AI prose — all three are untrusted — and the only thing between
// them and a client's document is this file.
//
// The refusals are asserted one construct at a time rather than through one
// "bad template", because a single fixture that trips several rules passes
// even when only one of them still works.

import { describe, it, expect } from "vitest";
import {
  assertTemplateAllowed,
  renderTemplate,
  scanAiSlots,
  TemplateViolation,
} from "./handlebars";

const DATA = {
  meta: { titulo: "Relatório", emissao: "20/08/2026" },
  nota: { numero: "FT 1", itens: [{ ref: "A" }, { ref: "B" }] },
  contrato: null,
  totais: { nota: { documento_cents: 123456 } },
};

describe("assertTemplateAllowed — refusals (§12.4)", () => {
  it("rejects {{{triple-stache}}}, naming the line", () => {
    expect(() => {
      assertTemplateAllowed("<p>ok</p>\n<p>{{{nota.numero}}}</p>");
    }).toThrowError(/triple-stache.*linha 2/su);
  });

  it("rejects a partial", () => {
    expect(() => {
      assertTemplateAllowed("{{> cabecalho}}");
    }).toThrowError(/partials proibidos/u);
  });

  it("rejects a helper outside the allowlist", () => {
    expect(() => {
      assertTemplateAllowed("{{lookup nota 'numero'}}");
    }).toThrowError(/fora da allowlist/u);
  });

  it("rejects a subexpression, even one whose helpers are allowlisted", () => {
    expect(() => {
      assertTemplateAllowed("{{money (money 1)}}");
    }).toThrowError(/subexpressões proibidas/u);
  });

  it("rejects block params", () => {
    expect(() => {
      assertTemplateAllowed("{{#each nota.itens as |item|}}{{item.ref}}{{/each}}");
    }).toThrowError(/parâmetros de bloco/u);
  });

  it("rejects named arguments", () => {
    expect(() => {
      assertTemplateAllowed("{{money nota.total moeda='eur'}}");
    }).toThrowError(/argumentos nomeados proibidos/u);
  });

  it("rejects prototype access", () => {
    expect(() => {
      assertTemplateAllowed("{{nota.constructor}}");
    }).toThrowError(/propriedade interna/u);
  });

  it("rejects {{ai}} without a literal slug", () => {
    expect(() => {
      assertTemplateAllowed("{{ai nota.numero}}");
    }).toThrowError(/slug entre aspas/u);
  });

  it("throws TemplateViolation, so callers can tell an author error from a bug", () => {
    let caught: unknown;
    try {
      assertTemplateAllowed("{{{x}}}");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TemplateViolation);
  });

  it("accepts exactly the four constructs of §3.2", () => {
    expect(() => {
      assertTemplateAllowed(
        `{{nota.numero}}` +
          `{{#each nota.itens}}{{ref}}{{/each}}` +
          `{{#if contrato}}x{{else}}y{{/if}}` +
          `{{money totais.nota.documento_cents}}{{date meta.emissao}}{{ai "parecer"}}`,
      );
    }).not.toThrow();
  });
});

describe("assertTemplateAllowed — the template's own markup", () => {
  // The full accept/reject table lives in html-safety.test.ts. What is
  // asserted here is that the gate RUNS it — the AST walk models mustaches
  // and treats the bytes between them as opaque, so without this call a
  // `<script>` in the textarea reaches the printed document untouched.
  it("runs the HTML scan as part of the same gate", () => {
    expect(() => {
      assertTemplateAllowed("<p>{{nota.numero}}</p><script>alert(1)</script>");
    }).toThrowError(/<script> proibido/u);
  });

  it("still accepts the print CSS the §5.4 contract requires", () => {
    expect(() => {
      assertTemplateAllowed("<style>@page { size: A4; }</style><p>{{nota.numero}}</p>");
    }).not.toThrow();
  });
});

describe("scanAiSlots", () => {
  it("returns the slugs in document order, deduplicated", () => {
    const slugs = scanAiSlots(
      `{{ai "notas"}} {{nota.numero}} {{ai "acompanhamento"}} {{ai "notas"}}`,
    );
    expect(slugs).toEqual(["notas", "acompanhamento"]);
  });

  it("finds slots inside blocks, not only at the top level", () => {
    expect(scanAiSlots(`{{#if contrato}}{{ai "clausulas"}}{{/if}}`)).toEqual(["clausulas"]);
  });

  it("runs the gate as it scans — a template it cannot render has no slot list", () => {
    expect(() => scanAiSlots(`{{ai "x"}}{{{nota.numero}}}`)).toThrowError(/triple-stache/u);
  });

  it("refuses to list slots for a template whose markup is unsafe", () => {
    expect(() => scanAiSlots(`{{ai "x"}}<script>alert(1)</script>`)).toThrowError(
      /<script> proibido/u,
    );
  });

  it("is empty for a template with no prose slots", () => {
    expect(scanAiSlots("<p>{{nota.numero}}</p>")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("escapes extraction values — they are untrusted content", () => {
    const html = renderTemplate(
      "<p>{{nota.numero}}</p>",
      { nota: { numero: "<script>x" } },
      {
        slots: {},
      },
    );
    expect(html).toBe("<p>&lt;script&gt;x</p>");
    expect(html).not.toContain("<script>");
  });

  it("escapes AI prose too", () => {
    const html = renderTemplate(`{{ai "p"}}`, {}, { slots: { p: "<img onerror=1>" } });
    expect(html).not.toContain("<img");
  });

  it("formats money from integer cents and dates verbatim", () => {
    const html = renderTemplate(
      `{{money totais.nota.documento_cents}}|{{date meta.emissao}}`,
      DATA,
      { slots: {} },
    );
    expect(html).toBe("1.234,56 €|20/08/2026");
  });

  it("throws on a typo'd path instead of rendering an empty string (strict mode)", () => {
    expect(() => renderTemplate("{{nota.numeroo}}", DATA, { slots: {} })).toThrow();
  });

  it("branches on an unfilled optional role rather than leaving a hole", () => {
    const html = renderTemplate("{{#if contrato}}tem{{else}}sem{{/if}}", DATA, { slots: {} });
    expect(html).toBe("sem");
  });

  it("refuses to render an unfilled slot when no placeholder is offered — that is publish", () => {
    expect(() => renderTemplate(`{{ai "parecer"}}`, DATA, { slots: {} })).toThrowError(
      /não preenchido/u,
    );
  });

  it("renders a placeholder for an unfilled slot when one is offered — that is a draft", () => {
    const html = renderTemplate(`{{ai "parecer"}}`, DATA, {
      slots: {},
      missingSlotText: (slug) => `[${slug}]`,
    });
    expect(html).toBe("[parecer]");
  });

  it("REFUSES markup the save-time gate would have refused — the belt", () => {
    // `outbound_template_versions` is immutable (§5.3), so a row written
    // before a rule existed can never be corrected in place. The render path
    // is the last place left to stop it — and the print window runs the
    // output same-origin with scripts live.
    expect(() => renderTemplate("<script>alert(1)</script>", DATA, { slots: {} })).toThrowError(
      /<script> proibido/u,
    );
    expect(() =>
      renderTemplate("<div onclick='x'>{{nota.numero}}</div>", DATA, { slots: {} }),
    ).toThrowError(/atributo de evento/u);
  });

  it("refuses the markup BEFORE compiling, so no partial output escapes", () => {
    let caught: unknown;
    try {
      renderTemplate("<p>ok</p><iframe src='https://evil.test'></iframe>", DATA, { slots: {} });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/§12\.4/u);
  });

  it("does not leak helpers between renders — each render gets a fresh env", () => {
    renderTemplate(`{{ai "a"}}`, {}, { slots: { a: "one" } });
    const second = renderTemplate(`{{ai "a"}}`, {}, { slots: { a: "two" } });
    expect(second).toBe("two");
  });
});
