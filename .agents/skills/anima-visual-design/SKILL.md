---
name: anima-visual-design
description: Use when creating, redesigning, polishing, or auditing any Anima Desktop screen, component, interaction, or visual state.
---

# Anima Desktop visual design

This project-local skill captures a focused design workflow inspired by Impeccable. It is tailored to Anima Desktop; it is not the official Impeccable package or CLI.

## Required context

1. Read the repository's `DESIGN.md` before making visual changes.
2. Inspect the target screen, its neighboring flows, existing shared components, and current tokens. Do not infer a new visual system from a single component.
3. Identify the user's primary job on this screen, the next useful action, and the status information they need to trust the workflow.
4. Preserve current behavior and the established interface outside the requested scope.

## Shape before editing

Before a broad UI change, outline the hierarchy and flow in a few bullets: what the user sees first, what action is primary, how progress or automation status is read, and what can stay secondary. Keep the explanation proportional to the requested scope. Avoid speculative features and decorative redesigns.

## Build with the Anima system

- Follow the palette and principles in `DESIGN.md`; reconcile with actual code tokens and reuse shared components.
- Keep the carmine and brass accents purposeful. Use text and shape as well as color to communicate state.
- Give each surface one clear primary action. Keep secondary and destructive actions distinct.
- Keep connected tasks visually related and use progressive disclosure for advanced or infrequent controls.
- Include empty, loading, success, error, paused, and needs-attention states when the changed flow needs them.
- Keep type hierarchy, spacing, alignment, focus states, contrast, and keyboard use consistent with the app.
- Avoid generic dashboard filler, nested card piles, decorative glow, gratuitous gradients, and ornamental labels.
- Keep Xenogears references indirect: no logos, named factions, recognizable symbols, characters, or lore.

## Inspect the rendered result

Source code is not a visual review. When a built desktop app is available, use the repository's existing Playwright smoke workflow and ask it to save the screenshot:

```powershell
$env:ANIMA_CAPTURE_DESKTOP_PREVIEW = "1"
pnpm desktop:smoke
```

The smoke script expects a built Windows app at `release/win-unpacked/Anima Connect.exe` unless `ANIMA_DESKTOP_EXECUTABLE` points elsewhere. On success, inspect `artifacts/anima-connect-desktop.png`; failures may save `artifacts/desktop-smoke-failure.png`. The smoke test exercises application behavior, so a passing run alone does not establish visual quality.

Review the screenshot for hierarchy, spacing, clipping, contrast, and visible state. Make one focused correction pass when needed. If the target screen is not represented in the smoke flow, inspect it directly in the running app at its normal and narrower supported window sizes; do not imply that the smoke screenshot covers that screen.
