---
name: anima-visual-design
description: Use when creating, redesigning, polishing, or auditing any Anima Desktop screen, component, interaction, or visual state.
---

# Anima Desktop visual design

This project-local skill captures a focused workflow inspired by Impeccable's shape, new-work, and operate guidance. It is tailored to Anima Desktop; it is not the official Impeccable package or CLI.

## Required context

1. Read the repository's `DESIGN.md` before making visual changes.
2. Inspect the target screen, neighboring flows, shared components, current tokens, and available screenshots. Do not infer a new visual system from a single component.
3. Identify the user's primary job on this screen, the next useful action, and the status information they need to trust the workflow.
4. Preserve current behavior and the established interface outside the requested scope.

## Shape before editing

Before a broad UI change, outline the hierarchy and flow in a few bullets: what the user sees first, what action is primary, how progress or automation status reads, and what can stay secondary. Keep the explanation proportional to the requested scope. Do not turn a precisely scoped request into a visual redesign.

## Build with the Anima system

- Follow the shared foundation and section mapping in `DESIGN.md`. Keep navigation, typography, spacing, controls, and interaction patterns consistent across the app.
- Use section accents only for small, meaningful signals. The mapping is Profile/setup → Weltall; Offer discovery → Weltall II; Campaigns → Weltall-Id; Overview/follow-up → Xenogears.
- Inspect the available reference images before setting or changing exact accent tokens. Do not invent precise colors from memory.
- Keep Weltall-Id red distinct from shared error and destructive colors.
- Give each surface one clear primary action. Keep secondary and destructive actions distinct.
- Include empty, loading, success, error, paused, and needs-attention states when the changed flow needs them.
- Keep type hierarchy, spacing, alignment, focus states, contrast, and keyboard use consistent with the app.
- Avoid generic dashboard filler, nested card piles, decorative glow, gratuitous gradients, and ornamental labels.
- Keep Xenogears references indirect: no logos, named factions, copied imagery, recognizable symbols, characters, or lore.

## Inspect the rendered result

Source code is not a visual review. When a built desktop app is available, use the repository's existing Playwright smoke workflow and ask it to save the screenshot:

```powershell
$env:ANIMA_CAPTURE_DESKTOP_PREVIEW = "1"
pnpm desktop:smoke
```

The smoke script expects a built Windows app at `release/win-unpacked/Anima Desktop.exe` unless `ANIMA_DESKTOP_EXECUTABLE` points elsewhere. On success, inspect `artifacts/anima-desktop.png`; failures may save `artifacts/desktop-smoke-failure.png`. The smoke test exercises application behavior, so a passing run alone does not establish visual quality.

Review the rendered screenshot for hierarchy, spacing, clipping, contrast, and visible state. Make one focused correction pass when needed. If the target screen is not represented in the smoke flow, inspect it directly in the running app at its normal and narrower supported window sizes; do not imply that the smoke screenshot covers that screen.
