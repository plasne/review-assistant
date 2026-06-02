# UI/UX Improvement Backlog

A prioritized list of opportunities to improve the Review Assistant renderer experience.
Items are grouped by theme; impact/effort are rough estimates to aid sequencing.

## Tabs (record detail navigation)

- **Keyboard navigation for the tablist.** The `node-tabs` tablist supports click only.
  Add arrow-key navigation, `Home`/`End`, and roving `tabIndex` so the tablist meets
  the WAI-ARIA tabs pattern. _(Impact: high, Effort: med)_
- **Close tab with keyboard / middle-click.** Allow `Delete`/`Backspace` on a focused
  tab and middle-click to close, matching common editor conventions. _(Impact: med, Effort: low)_
- **Focus handling after close.** When the active tab is closed, move focus to a sensible
  neighbor (previous tab or Overview) instead of dropping focus to the body. _(Impact: med, Effort: low)_
- **Overflow affordance.** The tablist scrolls horizontally with no visible cue. Add
  gradient/scroll buttons or an overflow menu when tabs exceed the available width. _(Impact: med, Effort: med)_
- **Truncate long tab labels.** Constrain tab width with ellipsis + `title` tooltip so a
  long evidence label can't push the close button off-screen. _(Impact: med, Effort: low)_
- **Persist open tabs per record.** Re-opening a record resets tabs to Overview. Consider
  remembering opened tabs (or at least the active tab) while navigating the queue. _(Impact: low, Effort: med)_

## Records list & navigation

- **Loading / empty / error states.** Provide skeletons while records load, a friendly
  empty state, and inline retry on fetch errors rather than a bare error panel. _(Impact: high, Effort: med)_
- **Keyboard list navigation.** Let users move through the records list with arrow keys
  and open with `Enter`. _(Impact: med, Effort: med)_
- **Search / filter records.** Add a filter box (by id, status, validation state) for
  large queues. _(Impact: high, Effort: med)_
- **Validation status at a glance.** Surface a per-record badge in the list showing
  pass/fail validation so reviewers can triage before opening. _(Impact: med, Effort: low)_

## Feedback & editing

- **Unsaved-changes protection.** Warn before navigating away from an in-progress edit or
  comment to avoid silent data loss. _(Impact: high, Effort: med)_
- **Inline submission feedback.** Show explicit success/error toasts and disable controls
  while a feedback submission is in flight. _(Impact: med, Effort: low)_
- **Diff readability.** Improve the edit-diff view with word-level highlighting and clear
  added/removed legends. _(Impact: med, Effort: med)_

## Accessibility

- **Focus-visible styling.** Ensure all interactive controls (tabs, close buttons, icon
  buttons) have a clear, consistent `:focus-visible` ring. _(Impact: high, Effort: low)_
- **Color-contrast audit.** Verify muted greys (e.g. tab labels `#8a93a0`) meet WCAG AA
  against their backgrounds. _(Impact: med, Effort: low)_
- **Respect reduced motion.** Gate any animations/transitions behind
  `prefers-reduced-motion`. _(Impact: low, Effort: low)_
- **Live-region announcements.** Announce tab open/close and feedback submission results
  to assistive tech via `aria-live`. _(Impact: med, Effort: low)_

## Visual & layout polish

- **Consistent icon-button system.** Standardize size, hit area (min 32px), padding, and
  hover/active states across `OpenInTabButton`, tab close, and queue toggles. _(Impact: med, Effort: low)_
- **Responsive columns.** The three-column layout (records/details/chat) can get cramped;
  add collapsible panels and sensible breakpoints for narrow windows. _(Impact: med, Effort: med)_
- **Design tokens.** Extract the hard-coded hex colors in `styles.css` into CSS custom
  properties for theming and consistency. _(Impact: med, Effort: med)_
- **Dark/light theme support.** Build on design tokens to offer a light theme. _(Impact: low, Effort: high)_

## Chat panel

- **Streaming + stop control.** Show streaming progress and a "stop generating" action for
  long Copilot responses. _(Impact: med, Effort: med)_
- **Scroll-to-bottom affordance.** Add a jump-to-latest button when the user has scrolled
  up during an active response. _(Impact: low, Effort: low)_
- **Copy / retry on messages.** Per-message copy and retry actions. _(Impact: low, Effort: low)_

## Next steps

Suggested first slice (high impact, low effort): tab keyboard navigation + focus handling,
focus-visible styling, label truncation, and inline feedback toasts.
