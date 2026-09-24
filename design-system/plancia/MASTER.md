# Plancia — design system (master)

Derived with the UI UX Pro Max rules (github.com/nextlevelbuilder/ui-ux-pro-max-skill):
`ui-reasoning.csv` rows for B2B / Analytics Dashboard / RPA-Operations, `styles.csv`
(Data-Dense Dashboard, Real-Time Monitoring, Minimalism & Swiss, Flat), `typography.csv`
(#42 Dashboard Data), `references/pro-rules.md` checklist. Page files may override; this file wins otherwise.

## Product read
Operations coordination for a contact-centre BPO. Users: Team Leaders on the floor (often on a phone),
Floor Managers, CSDMs, COO. Priority: **state clarity and ownership over decoration.**

## Pattern & style
- Pattern: Data-Dense Dashboard + Real-Time Monitoring (connection status, live refresh, critical alerts prominent).
- Style: Minimalism & Swiss + Flat. Surfaces separate by **1px borders**, not shadows. Elevation only for drawer/modal.
- Density dial ≈ 7/10: 8px rhythm, 36px table rows, 12–16px card padding, sidebar 232px, header 56px.
- Motion dial ≈ 2/10: colour/opacity shifts at 150ms, no transforms on hover, `prefers-reduced-motion` disables all.

## Colour (semantic tokens only, both themes)
| Token | Light | Dark | Use |
|---|---|---|---|
| accent | #1d4ed8 | #7aa2ff | primary action, links, current nav |
| ok / warn / danger (text) | #15803d / #b45309 / #b91c1c | #4ade80 / #fbbf24 / #f87171 | status text, ≥4.5:1 |
| ok / warn / danger (solid) | #22c55e / #f59e0b / #ef4444 | same | bars, dots — never alone |
| layer TL / FM / CSDM / COO | blue / teal / violet / slate | lighter tints | ownership chips |
| text-3 (faint) | #5f6b7a (5.3:1) | #8b96a6 (≥5:1) | secondary text, never lower |

Anti-patterns: AI purple/pink gradients, decorative charts, colour as the only signal, hidden error states, dark mode forced by default.

## Type
Fira Sans (UI) + Fira Code (refs, numbers in tables via tabular-nums). Body 14px/1.5 (dashboard density), minimum 12px anywhere, KPI 24px.

## Icons
Lucide, stroke 2, sizes 16 (inline) / 18 (nav). No emoji or text glyphs as controls. Icon-only buttons carry `aria-label`.

## Interaction
- Every interactive element has a visible `:focus-visible` ring (2px accent, 2px offset).
- Touch targets ≥44px under 760px width; inputs 16px there (no iOS zoom).
- Tables: sortable headers with `aria-sort`, row hover highlight.
- Loading: skeleton rows, not bare "Loading…".
- Critical issues and overdue escalations: a persistent alert bar under the header.

## Pre-delivery (from pro-rules)
375 / 768 / 1024 / 1440 widths · both themes · reduced motion · no horizontal scroll · focus order = visual order.
