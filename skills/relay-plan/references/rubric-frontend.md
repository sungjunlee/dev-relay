# Rubric — Frontend

Metrics a senior frontend engineer actually checks. Not "does it render" but "does it respect the user's time, device, and attention."

## Automated Checks

| Factor | Command | Target | Why it matters |
|--------|---------|--------|---------------|
| Perceived performance | `npx lighthouse --quiet --output=json --only-categories=performance \| jq '.categories.performance.score * 100'` | ≥ 90 | Users leave at 3s. Lab score catches regressions before users do. |
| Layout stability | `npx lighthouse --quiet --output=json \| jq '.audits["cumulative-layout-shift"].numericValue'` | ≤ 0.1 | CLS breaks user's spatial memory. A button that jumps is worse than a slow button. |
| Accessibility violations | `npx axe --exit` or `npx pa11y <url> --threshold 0` | 0 violations | Not a nice-to-have. 15% of users have a disability. axe catches what eyes don't. |
| Bundle size budget | `npx bundlesize` or `du -b dist/main.*.js` | ≤ budget (define per project) | Every KB is a tax on mobile users. Set the budget once, defend it forever. |
| Type safety | `npx tsc --noEmit` | exit 0 | Catches the bugs that "it works on my machine" misses. Runtime is too late. |

## Evaluated Factors

These are the things that separate senior frontend work from "it works."

### Interaction fidelity (target: ≥ 8/10)

Does the UI respond like the user expects, or like the developer found convenient?

- **Loading states**: Is there a meaningful skeleton/placeholder, or just a spinner? Does the user know *what* is loading and *roughly how long*?
- **Optimistic updates**: For actions the user expects to be instant (like, toggle, drag), does the UI respond immediately and reconcile later?
- **Error recovery**: When something fails, can the user retry from where they were? Or do they lose their work and start over?
- **Transitions**: Do state changes communicate what happened? A list item disappearing without animation feels like a bug. With a fade-out, it feels intentional.

Score low if: spinners everywhere, errors as alert() dialogs, state changes that feel like page refreshes.

### Information hierarchy (target: ≥ 7/10)

If a user glances at the screen for 3 seconds, do they see what matters most?

- **Visual weight matches importance**: The primary action is the most prominent element. Not buried in a toolbar. Not competing with 5 other buttons of equal weight.
- **Progressive disclosure**: Show the essential, reveal the rest on demand. A settings page with 40 visible fields is a failure of hierarchy, not a feature of completeness.
- **Empty states**: First-time or zero-data states should guide, not just say "No data." This is the moment you earn or lose the user.

Score low if: every element screams for attention equally, empty states are afterthoughts, CTAs are ambiguous.

### Component boundaries (target: ≥ 7/10)

Are the component splits serving the user's mental model, or the developer's file organization?

- **Reusability that earns its cost**: A `<Button>` component makes sense. A `<UserProfileCardHeaderLeftSection>` does not. Abstraction should reduce total complexity, not distribute it.
- **Data flow clarity**: Can you trace where state lives and how it flows without reading 6 files? If a prop drills through 4 levels, the boundary is wrong.
- **Render efficiency**: Does changing one input re-render the whole page? React.memo and useMemo are band-aids — the real fix is better component boundaries.

Score low if: prop drilling > 3 levels, components that only make sense in one context but are "reusable," unnecessary re-renders visible in profiler.

### Responsive integrity (target: ≥ 7/10)

Not "does it fit on mobile" but "does it *work* on mobile."

- **Touch targets**: 44x44px minimum. Not "it's technically tappable" but "a thumb on a bus can hit it."
- **Content priority shift**: Mobile isn't a smaller desktop. What's most important changes. A sidebar navigation that becomes a hamburger is the minimum; rethinking what's primary is the goal.
- **Input adaptation**: Correct keyboard types (email, number, tel). Autocomplete attributes. No hover-dependent interactions on touch devices.

Score low if: text is readable but buttons are untappable, horizontal scrolling appears, hover tooltips are the only way to see critical info.
