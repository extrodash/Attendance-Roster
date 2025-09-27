# UI Refactor Notes

## Audit Snapshot
- Check In: Primary action `Save`; friction: crowded controls, duplicative chips, advanced toggles always visible.
- Roster: Primary `Add Missionary`; friction: dense table labels, bulk actions floating, inconsistent row actions.
- Insights: Primary `Run`; friction: filter wall, toggles flat list, summary scattered.
- Trends: Primary `Run`; friction: similar to insights plus thresholds block overwhelming.
- Calendar: Primary `Open day in Check In`; friction: controls stacked, calendar legend unclear.
- Settings: Primary `Adjust team + thresholds`; friction: sections verbose, actions blend with surroundings.
- Modals/Toasts: Primary actions `Save`; friction: extra decoration, button hierarchy unclear.

## Friction Themes
- Navigation duplicates analytics (Trends vs Insights) without obvious distinction.
- Controls lack grouping leading to scanning cost.
- Surfaces rely on heavy gradients/shadows reducing contrast clarity.
- Copy leans metaphorical instead of action-oriented.
- Advanced options (weights, smoothing, comparisons) surface before basics.

## Style Tokens
- Color: `--color-bg:#08111c`, `--color-surface:#111b1f`, `--color-surface-alt:#162233`, `--color-border:#1f2d40`, `--color-border-strong:#33445c`, `--color-text:#f5f7fb`, `--color-muted:#9cabc0`, `--color-primary:#2dd4bf`, `--color-primary-strong:#14b8a6`, `--color-warn:#fbbf24`, `--color-danger:#f87171`, `--color-success:#34d399`, `--color-info:#38bdf8`.
- Spacing: `--space-1:4px`, `--space-2:8px`, `--space-3:12px`, `--space-4:16px`, `--space-5:24px`, `--space-6:32px`, `--space-7:40px`.
- Typography: Sans stack `"Inter", "Segoe UI", system-ui`; sizes `--fs-xs:12px`, `--fs-sm:13px`, `--fs-md:14px`, `--fs-lg:16px`, `--fs-xl:20px`, `--fs-2xl:26px` with line-height `1.45` default.
- Radii: `--radius-sm:6px`, `--radius-md:10px`, `--radius-lg:16px`.
- elevation: `--shadow-soft:0 8px 16px rgba(5,11,19,0.35)`, `--shadow-sm:0 4px 12px rgba(0,0,0,0.2)`.

## Layout System
- Page shell is a centered column at `max-width:1120px` with side padding `clamp(16px, 4vw, 40px)`.
- Views use vertical rhythm of `--space-6` between major blocks and `--space-4` inside panels.
- Two-column areas (`take-layout`) collapse to single column below `1024px`, with sticky sidebars only on wide screens.
- Control groups use two-column auto-fit grid with min `220px`; advanced items slot into `<details>` wrappers for progressive disclosure.
- Navigation compresses into horizontal scroll if needed, but keeps single primary CTA per view anchored at footer/top.

### Visual Hierarchy Brainstorm
- Make global primary actions impossible to miss: bigger buttons, left-aligned for scan, consistent accent fill.
- Reinforce hierarchy between core workspace vs supporting controls using subtle colored borders/top bars.
- Use color families to bind related controls (attendance actions = teal, analytics insights = indigo, risk/danger = coral).
- Increase title/type contrast by pairing larger weight for headlines with muted helper text.
- Clarify control groups with quiet section headings instead of bare stacks.
- Keep charts/cards within predictable aspect ratios to avoid visual dominance.
- `Session basics` redesign idea: convert date + navigation into a segmented control with labeled shortcuts, ensure buttons align to input edges, add contextual feedback (e.g., current weekday) and separate the “Today” shortcut into a tertiary button grouped with prev/next.

## Component Guidelines
- `AppHeader`: brand left, concise utility right, highlight current view with underline token.
- `NavButton`: small pill, media-query compressible, single active state using `--color-primary` underline.
- `Panel`: surface background `--color-surface`, border `--color-border`, padding `--space-4`, gap `--space-4`.
- `Panel.primary-panel`: adds accent border-top and deeper shadow; `Panel.support-panel` keeps lower elevation for filters.
- `FieldGroup`: stacked labels with muted text, inputs full width, optional inline adornments kept inside `.field-inline`.
- `PrimaryButton`: filled with `--color-primary`, only one per view header/footer; `SecondaryButton` uses outline.
- `PrimaryButton` now grows to 44px min-height and adopts each view’s accent via `data-tone` tokens.
- `Tag/Chip`: neutral background using `--color-surface-alt`, uppercase optional.
- `Card`: flex/column with minimal shadow `--shadow-soft`, evenly spaced headings.
- `DataTable`: plain rows, zebra with `--color-surface-alt`, actions consolidated into compact icon/text buttons.
- `Modal`: center, width `min(480px,100%)`, header + body + footer pattern, focus trap preserved via existing JS.

## Changelog (Remove → Reduce → Reorganize)
- Simplified global header (`index.html`) by removing decorative emoji/tagline block and flattening nav into a single responsive list; new copy clarifies the product promise in one line.
- Replaced form “walls” with progressive disclosure: check-in bulk tools, analytics and trends filters, thresholds, and calendar weighting now live inside `<details>` blocks so core inputs stay visible (`index.html` sections for take/insights/trends/calendar).
- Highlighted one primary action per view by moving key buttons (`save-attendance`, `add-person-btn`, `analytics-run`, `trends-run`, `cal-today`, `download-json`) into consistent `view-actions` containers; secondary actions adopt the outline style.
- Consolidated summary cards and chip styles to a single `card`/`chip` system in `styles.css`, removing bespoke gradients and heavy shadows for faster scan.
- Standardised layout tokens and spacing via the new scale in `styles.css`, eliminating ad-hoc gaps, gradients, and inline typography variants.
- Updated modal markup to reuse field patterns and explicit primary/secondary buttons, reducing redundant helper classes and clarifying focus order.
- Introduced `data-tone` accents so each view telegraphs context (teal for check-in, indigo for analytics, etc.) and panels/buttons inherit the matching hue.
- Added section labels for control blocks to improve scan paths and align headings with spoken navigation.
- Rebuilt Check-in "Session basics" controls into a segmented day switcher and clearer date input with live weekday hint.

## QA Checklist
- Verified every `document.getElementById` reference still exists via a Python id diff (`python3` snippet); only dynamic ids (`cal-open-take`) and pre-existing gaps (`trends-search`) remain.
- Spot-checked transformed views to ensure required IDs and ARIA landmarks (`view-take`, `people-list`, `calendar-grid`) remain untouched, keeping data flows intact.
- Confirmed progressive disclosure keeps keyboard order logical: summary + advance controls use native `<details>` so they are tabbable and announce state.
- Reviewed color contrast against WCAG AA: primary on dark background hits >4.5:1, muted text reserved for supporting copy.
- Ensured responsive breakpoints collapse the take sidebar and reflow cards without horizontal scroll; print stylesheet still hides controls for clean exports.
- Spot-checked accent overrides to make sure high-contrast text colors switch to light text on indigo/violet palettes.
