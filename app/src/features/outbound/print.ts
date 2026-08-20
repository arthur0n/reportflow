// app/src/features/outbound/print.ts
//
// §5.4 — browser print, zero PDF dependencies. Settled by precedent: Chrome's
// print engine IS headless Chrome, so the exported PDF has selectable text,
// correct accents, and costs nothing.
//
// A NEW WINDOW, not `iframe.contentWindow.print()`. The preview frame runs
// under `sandbox=""` (§12.4) and a sandboxed frame without `allow-modals`
// cannot open the print dialog at all. Widening the sandbox to allow it would
// trade the security wall for a convenience, so the window gets the SAME html
// instead — what prints is exactly what was previewed, including the
// template's own `@page` rules.
//
// Known and accepted (§5.4): no page numbers. Blink does not implement CSS
// Paged Media margin boxes, so running headers/footers are not achievable
// here. Users untick the browser's own header/footer so the PDF is exactly
// the HTML.

/** Opens the rendered document in its own window and prints it. Returns false
 * when the pop-up was blocked, so the caller can say so. */
export function printHtml(html: string): boolean {
  const win = window.open("", "_blank", "width=980,height=1200");
  if (win === null) {
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // One tick for layout and webfonts before the dialog opens; printing an
  // unlaid-out document is how a blank first page happens.
  win.setTimeout(() => {
    win.print();
  }, 400);
  return true;
}
