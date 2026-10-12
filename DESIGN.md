# Anima Desktop — design context

## Product and users

Anima Desktop is a Windows desktop app for organizing and automating job applications. It helps a job seeker maintain a profile and multiple CVs, discover opportunities, prepare applications, track progress, and know when a human needs to take over.

The interface should make the next useful action obvious while keeping automation status, application details, and user control easy to understand.

## Visual direction

Use the first “Carmin technique” direction from the Anima identity mockups as the working visual baseline: quiet ivory surfaces, charcoal-green text, restrained carmine for meaningful actions and active states, and muted brass for secondary emphasis.

This is a working baseline from the mockups, not a reason to repaint the whole app in one pass. Preserve existing components and behavior unless the requested scope calls for a redesign. Keep the other mockup directions (“Nuit de Weltall” and “Papier d’archive”) as alternatives; do not mix their palettes into a single screen.

The Xenogears inspiration should remain indirect: subtle material warmth, a sense of a connected journey, and a few restrained geometric cues. Do not use game logos, named factions, characters, recognizable symbols, or lore.

## Working color tokens

These values come from the “Carmin technique” mockup and may be used when creating or consolidating shared design tokens:

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#F4F3ED` | Main window background |
| Surface | `#FFFEFA` | Primary content surfaces |
| Surface secondary | `#EEEEE4` | Quiet grouping and selected neutral areas |
| Ink | `#26332F` | Primary text and strong icons |
| Muted ink | `#768078` | Supporting text |
| Border | `#E1E2D8` | Dividers and control outlines |
| Carmine | `#994047` | Primary action and current location, used sparingly |
| Carmine soft | `#F1E6E2` | Selected navigation and subtle emphasis |
| Carmine ink | `#79353D` | Text and icons on carmine-soft surfaces |
| Muted brass | `#A48657` | Secondary emphasis and progress detail |
| Brass soft | `#F3EDE3` | Quiet brass-tinted surface |
| Danger | `#AA6457` | Errors and destructive states |

Treat these as a direction to reconcile with the tokens already in the code. Avoid introducing duplicate one-off colors. Do not use carmine or brass as decoration where they do not clarify hierarchy or state.

## Interaction and hierarchy

- Organize screens around the user's immediate task and its next step.
- Keep one clear primary action per surface; make secondary and destructive actions visually distinct.
- Let status and progress read before supporting detail. Use progressive disclosure for uncommon or advanced options.
- Keep related steps visually connected without making the interface feel like a game HUD.
- Distinguish automated work, user review, and blocked states with explicit labels and accessible color-plus-text cues.
- Use motion only to explain a state change or maintain orientation; keep it short and unobtrusive.
- Design loading, empty, success, error, paused, and needs-attention states with the same hierarchy as the happy path.

## Quality bar

Prefer purposeful typography, consistent spacing, clear grouping, strong alignment, and restrained surface treatment. Avoid default-looking gradients, decorative glow, nested card piles, ornamental labels, and generic dashboard filler. Do not remove useful information density just to make a screen look sparse.

All screens must remain legible and usable at supported Windows window sizes, with clear keyboard focus and sufficient contrast. Preserve the app's existing interaction patterns unless the task specifically changes them.

## Visual verification

For a visual change, inspect the built Electron UI at its actual desktop size. The repository already uses Playwright in `scripts/desktop-smoke.mjs`; when a packaged build is available, run the smoke script with `ANIMA_CAPTURE_DESKTOP_PREVIEW=1` to save `artifacts/anima-connect-desktop.png`. Review the rendered screenshot, not just the DOM or source, and fix visible hierarchy, spacing, clipping, and contrast issues in a bounded pass. Do not claim a visual pass from a smoke-test success alone.
