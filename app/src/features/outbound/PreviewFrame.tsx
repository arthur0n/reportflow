// app/src/features/outbound/PreviewFrame.tsx
//
// §12.4's sandboxed preview, and the print entry point (§5.4).
//
// `sandbox=""` — the EMPTY value, not `sandbox="allow-scripts"` and not a
// missing attribute. An empty sandbox denies everything the flag list can
// grant: no scripts, no same-origin, no forms, no top-level navigation. The
// frame's content is a template a model authored, filled with extraction
// values and AI prose; all three are untrusted (§12.4), and the server-side
// engine escapes them, but the frame is the second wall and it costs nothing.
//
// PRINTING OPENS A WINDOW rather than calling `iframe.contentWindow.print()`:
// a sandboxed frame with no `allow-modals` cannot open the print dialog at
// all. The window gets the SAME html, so what prints is what was previewed —
// including the template's own `@page` rules, which is the whole davori
// pattern (§5.4). No PDF dependency, no server-side Chrome.

import type { ReactElement } from "react";

export function PreviewFrame({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}): ReactElement {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className={className ?? "h-[70vh] w-full border border-[color:var(--rule-strong)] bg-white"}
    />
  );
}
