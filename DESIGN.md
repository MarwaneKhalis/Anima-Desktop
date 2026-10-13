# Anima Desktop — design context

## Product and users

Anima Desktop is a Windows desktop app for organizing and automating job applications. It helps a job seeker maintain a profile and multiple CVs, discover opportunities, prepare applications, track progress, and know when a human needs to take over.

The interface should make the next useful action obvious while keeping automation status, application details, and user control easy to understand.

## Visual direction

Use one coherent desktop interface, with a shared neutral foundation and restrained visual accents that distinguish major areas. The user has approved Xenogears/Weltall as the inspiration family and this working mapping:

| App area | Inspiration | Visual cue |
| --- | --- | --- |
| Profile and setup | Weltall | Indigo-blue steel and silver, with a small carmine signal |
| Offer discovery | Weltall II | Cooler blue-steel emphasis and a more technical, ordered feel |
| Application campaigns | Weltall-Id | Deep carmine/oxide red and graphite, kept to compact active-process accents |
| Overview and follow-up | Xenogears | Pearl/ivory base with restrained blue-violet, carmine, and muted gold details |

These are design cues, not separate themes. Keep page backgrounds, navigation, typography, spacing, controls, and interaction patterns consistent across the app. Apply area colors only through restrained accents such as active navigation, small labels, progress details, and selected controls. Do not tint whole screens by default.

The Xenogears inspiration should remain indirect: use the shift from cool mechanical steel to a more integrated, luminous palette as a subtle visual story. Do not use game logos, named factions, characters, recognizable symbols, copied artwork, or lore.

## Shared foundation

The previous mockups provide a provisional neutral foundation. Reconcile it with the tokens already in code before implementing changes; these values are a starting point, not permission for a wholesale recolor.

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#F4F3ED` | Main window background |
| Surface | `#FFFEFA` | Primary content surfaces |
| Surface secondary | `#EEEEE4` | Quiet grouping and selected neutral areas |
| Ink | `#26332F` | Primary text and strong icons |
| Muted ink | `#768078` | Supporting text |
| Border | `#E1E2D8` | Dividers and control outlines |

Area colors should be selected and checked against the actual reference art before creating shared tokens. Use accessible contrast and preserve one shared danger color for errors and destructive actions; Weltall-Id red must not make normal campaign activity look like an error.

## Interaction and hierarchy

- Organize screens around the user's immediate task and its next step.
- Keep one clear primary action per surface; make secondary and destructive actions visually distinct.
- Let status and progress read before supporting detail. Use progressive disclosure for uncommon or advanced options.
- Keep connected tasks visually related without making the interface feel like a game HUD.
- Distinguish automated work, user review, and blocked states with explicit labels as well as color.
- Use motion only to explain a state change or maintain orientation; keep it short and unobtrusive.
- Design loading, empty, success, error, paused, and needs-attention states with the same hierarchy as the happy path.

## Quality bar

Prefer purposeful typography, consistent spacing, clear grouping, strong alignment, and restrained surface treatment. Avoid default-looking gradients, decorative glow, nested card piles, ornamental labels, and generic dashboard filler. Do not remove useful information density just to make a screen look sparse.

All screens must remain legible and usable at supported Windows window sizes, with clear keyboard focus and sufficient contrast. Preserve the app's existing interaction patterns unless the task specifically changes them.

## Visual verification

For a visual change, inspect the built Electron UI at its actual desktop size. The repository already uses Playwright in `scripts/desktop-smoke.mjs`; when a packaged build is available, run the smoke script with `ANIMA_CAPTURE_DESKTOP_PREVIEW=1` to save `artifacts/anima-desktop.png`. Review the rendered screenshot, not just the DOM or source, and fix visible hierarchy, spacing, clipping, and contrast issues in a bounded pass. Do not claim a visual pass from a smoke-test success alone.
