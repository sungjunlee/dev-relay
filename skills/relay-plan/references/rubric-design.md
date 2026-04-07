# Rubric — Design & UX

Metrics a design-minded product engineer checks. Not "does it look nice" but "does the user succeed, and do they feel confident doing it."

Follows the feedback hierarchy from product leaders: **Value → Usability → Delight.** Each layer is a gate — don't polish the animation on a feature that solves the wrong problem.

## Prerequisites (Hygiene)

Use this section only for checks that would apply to ANY PR in this repo. They gate the run and do not count toward factor totals.

| Check | Command | Target | Why it matters |
|-------|---------|--------|----------------|
| Preview smoke test | `npx playwright test <smoke-spec>` or repo preview smoke command | exit 0 | Repo-wide hygiene if every UI PR must clear it. Keep it in `prerequisites`, not `factors`. |
| Accessibility smoke | `npx axe --exit <preview-url>` | 0 critical/serious violations | Generic floor for every preview, not proof that this specific UX task is well-designed. |

## Automated Checks (Contract-tier)

These stay in `factors` because they verify a SPECIFIC AC item is implemented.

| Factor | Tier | Command | Target | Why it matters |
|--------|------|---------|--------|---------------|
| Contrast ratios | `contract` | `npx axe --rules color-contrast` | 0 violations (4.5:1 text, 3:1 large) | Readable in a sunny café, not just on your calibrated monitor in a dark room. |
| Touch target sizes | `contract` | Audit via Lighthouse or custom check | ≥ 44x44px interactive elements | Thumbs on a moving bus. Not fingertips on a stable desk. |
| Responsive breakpoints | `contract` | `npx playwright test` at 375px, 768px, 1440px | No horizontal overflow, no hidden CTAs | The design must work at every breakpoint, not just the one in the Figma file. |

## Evaluated Factors

These follow the **Value → Usability → Delight** hierarchy. Score each layer independently — a high delight score cannot compensate for a low value score.

### Layer 1: Value (target: ≥ 8/10)

tier: quality

Does this solve the right problem? (If this fails, nothing else matters.)

- **Problem-solution fit**: Can you articulate the user's problem in one sentence without mentioning the feature? "Users can't find past orders" is a problem. "Users need a search filter modal" is a solution disguised as a problem. Score whether the implementation addresses the actual need.
- **The 3-second test**: If a new user sees this screen for 3 seconds and looks away, what do they understand? What's the primary action? If they can't answer, the value proposition isn't communicated.
- **Unnecessary complexity**: Does this feature exist because users need it, or because the spec said so? A settings page with 20 toggles is a confession that you couldn't make decisions. Every option is a question the user didn't want to answer.

Scoring guide:
- **low**: Feature solves an assumed problem without evidence, primary action isn't obvious, user has to make decisions the product should make.
- **mid**: Problem-solution fit is plausible, primary action identifiable, but unnecessary complexity remains (too many options, too many steps).
- **high**: Clear problem evidence, 3-second test passes, product makes sensible defaults — user decides only what they care about.

### Layer 2: Usability (target: ≥ 8/10)

tier: quality

Can the user succeed without instructions? (Only evaluate after Layer 1 passes.)

- **Task completion path**: What's the minimum number of steps to complete the primary task? Count clicks, page loads, decisions. If a competitor does it in 2 steps and you do it in 5, that's not thoroughness — it's friction.
- **Error prevention > error handling**: Is the UI designed to prevent mistakes, or to catch them after? Disabling a "Submit" button until the form is valid is prevention. Showing a red toast after submission is handling. Prevention wins.
- **Cognitive load**: How many things must the user hold in their head simultaneously? A form that requires remembering a value from a previous screen is a working memory violation. Show it or link back to it.
- **Familiar patterns**: Does the interaction match what the user already knows from other apps? Innovation in navigation or input patterns is almost always friction disguised as creativity.

Scoring guide:
- **low**: Task requires more steps than necessary, errors are caught not prevented, user must remember context from previous screens.
- **mid**: Reasonable step count, some error prevention, but cognitive load still high — user juggles context across views.
- **high**: Minimum viable steps, errors prevented not caught, all needed context visible on screen — no working memory violations.

### Layer 3: Delight (target: ≥ 7/10)

tier: quality

Does using it feel good? (Only evaluate after Layers 1 and 2 pass.)

- **Feedback and responsiveness**: Does every action produce immediate, visible feedback? A button that feels dead for 500ms after clicking is anxiety-inducing. A button that subtly depresses, shows a loading indicator, and transitions to a success state is confidence-building.
- **Consistency and polish**: Do similar elements look and behave similarly? Is spacing consistent? Do animations serve communication (showing where an element went) or are they just movement for movement's sake?
- **Personality without interference**: Does the product have a voice that makes it memorable without getting in the way of the task? A playful empty state illustration is delight. A playful error message when the user lost their data is tone-deaf.

Scoring guide:
- **low**: No feedback on user actions, inconsistent visual treatment of similar elements, personality that interferes with task completion.
- **mid**: Immediate feedback on actions, mostly consistent visuals, but transitions feel mechanical rather than intentional.
- **high**: Every action has confident feedback, spacing and animation serve communication, personality enhances without interfering.

### Design-specific meta-check: Hierarchy coherence (target: ≥ 7/10)

tier: quality

Step back and blur your eyes (Jessica Hische's "blurred vision" technique). Does the overall page hold together?

- **Visual weight distribution**: Is the most important element the visually heaviest? Or does a decorative sidebar steal attention from the primary content?
- **Whitespace as structure**: Is the spacing doing work — grouping related items, separating sections — or is it just "padding: 16px everywhere"?
- **One primary action per screen**: If you can't point to THE thing this screen wants the user to do, the hierarchy has failed. Two equally prominent CTAs is zero clear CTAs.

Scoring guide:
- **low**: Competing visual elements of equal weight, no clear focal point, spacing that doesn't reflect content relationships.
- **mid**: One clear focal point, but whitespace is uniform ("padding: 16px everywhere") rather than structural.
- **high**: Visual weight matches importance, whitespace groups related items and separates sections, one primary action per screen.

## Tool → Automated Check Mapping

| Tool | Automated check | Replaces evaluated |
|------|----------------|-------------------|
| Playwright | `npx playwright test` → screenshot comparison | Visual consistency (partial) |
| `/browse` skill | Navigate flows, screenshot each state | User flow completion |
| Lighthouse | `npx lighthouse --only-categories=accessibility` → score ≥ 90 | Inclusive design basics |
| axe-core | `npx axe --exit <url>` → 0 violations | Color contrast, ARIA |
| `/design-review` skill | Visual audit with before/after diffs | Design polish (partial) |
