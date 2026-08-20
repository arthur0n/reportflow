// Shared appearance tokens for the auth provider's hosted widgets. Lives next
// to the wrappers so the rest of the app never sees provider-specific shapes.

export const authWidgetAppearance = {
  variables: {
    colorPrimary: "oklch(0.55 0.18 32)",
    colorText: "oklch(0.2 0.022 285)",
    colorTextSecondary: "oklch(0.54 0.012 85)",
    colorBackground: "oklch(0.978 0.008 85)",
    colorInputBackground: "transparent",
    colorInputText: "oklch(0.2 0.022 285)",
    colorNeutral: "oklch(0.88 0.012 85)",
    fontFamily: '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    borderRadius: "4px",
  },
  elements: {
    rootBox: "w-full",
    card: "bg-transparent shadow-none border-0 p-0",
    headerTitle: "font-serif text-[1.75rem] font-[500] tracking-[-0.018em]",
    headerSubtitle: "text-[length:var(--fs-body-sm)]",
    formButtonPrimary:
      "bg-[color:var(--accent)] hover:bg-[color:var(--accent-deep)] text-[color:var(--paper)] rounded-[4px] normal-case font-[500] tracking-[-0.005em]",
    socialButtonsBlockButton:
      "border border-[color:var(--rule-strong)] hover:bg-[color:var(--paper-sink)]",
    formFieldInput:
      "border-0 border-b border-[color:var(--rule-strong)] bg-transparent rounded-none focus:border-[color:var(--accent)]",
    footerActionLink:
      "text-[color:var(--accent)] hover:text-[color:var(--accent-deep)] underline-offset-4 hover:underline",
  },
};
