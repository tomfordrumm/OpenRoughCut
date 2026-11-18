---
target: website homepage
total_score: 18
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 2
timestamp: 2026-07-30T10-25-40Z
slug: website-app-page-tsx
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 2 | First-launch and download expectations are not explicit. |
| 2 | Match System / Real World | 3 | Editor language is natural, but FCPXML and OTIO are unexplained. |
| 3 | User Control and Freedom | 2 | The illustrated Export timeline button suggests an unavailable action. |
| 4 | Consistency and Standards | 3 | The system is strong, but external-link behavior is inconsistent. |
| 5 | Error Prevention | 1 | The unsigned-installer warning appears late and gives little pre-emptive guidance. |
| 6 | Recognition Rather Than Recall | 3 | Builds are visible, but visitors must self-identify CPU architecture. |
| 7 | Flexibility and Efficiency | n/a | Persuade surface. |
| 8 | Aesthetic and Minimalist Design | 3 | Strong hierarchy, although decorative and repeated headline moments compete with conversion proof. |
| 9 | Error Recovery | 1 | The OS-approval warning has no actionable recovery path. |
| 10 | Help and Documentation | n/a | Persuade surface. |
| **Total** | | **18/32** | **Acceptable; significant trust and onboarding gaps** |

## Design Specificity Verdict

**Partly authored, not yet unmistakable.** The editorial ink/acid/coral system, Bodoni-scale headlines, waveform, and local-first positioning create a coherent point of view. The hero's abstract app window, orbit rings, and blob remain a familiar creative-tool pattern, however. The product's decisive differentiators—local analysis, reviewable removals, and editable timelines—are asserted in copy more than made visually undeniable.

The deterministic scan returned **0 findings** for `website/app/page.tsx`. It did not contradict the design review or surface extra mechanical issues. Browser overlay evidence was unavailable because the browser environment did not provide mutable DOM/script injection, so no live-server or human overlay was started.

## Overall Impression

This is an unusually polished early-release landing page with a crisp creative-editorial voice. Its largest missed opportunity is that the trust-intensive download moment is less clear and less reassuring than the rest of the page.

## What's Working

- The core job is immediately legible: remove dead air while retaining an editable timeline.
- Ink, paper, acid, coral, hairline rules, and editorial typography form a disciplined visual family.
- The early format strip answers a decisive compatibility question before the visitor reaches download.

## Priority Issues

### [P1] Conversion trust breaks at the installer warning

**Why it matters:** An unsigned desktop installer is abandonment-prone. The current warning turns anticipation into uncertainty without telling people how to proceed safely.

**Fix:** Put a compact “Before you download” panel above the build choices: supported OS versions, an architecture-selection aid, expected first-launch download size/time, checksum verification, and platform-specific approval steps. Link the warning to that guidance.

**Suggested command:** `$impeccable harden`

### [P1] The hero demonstrates a generic editor, not the decisive product advantage

**Why it matters:** Local, editable, reviewable automation is why OpenRoughCut exists, but the hero reads as a generic creative-app mockup.

**Fix:** Show a credible before/after review state: original waveform, proposed removals, an explicit restore control, and named editable exports. Prefer one faithful workflow over decorative orbit geometry.

**Suggested command:** `$impeccable bolder`

### [P2] Download is a five-way decision

**Why it matters:** Visitors must diagnose architecture while parsing integrity and release links.

**Fix:** Detect the platform client-side and lead with one “Download for this Mac/PC” action; place alternatives and integrity details under “Other downloads,” retaining a manual selector.

**Suggested command:** `$impeccable distill`

### [P2] Keyboard and low-vision cues are incomplete

**Why it matters:** No authored `:focus-visible` styles are present, hover does meaningful work, and 8–11px support text carries essential installer context.

**Fix:** Add high-contrast focus indicators to links, cards, and buttons; mirror hover states on focus; raise critical support-copy size; test muted dark-section text to AA contrast.

**Suggested command:** `$impeccable audit`

### [P3] Repetition uses space that could establish proof

**Why it matters:** The page is polished before it is evidenced.

**Fix:** Replace one slogan-sized section with a concise Import → review cuts → export editable timeline sequence and a concrete before/after benefit.

**Suggested command:** `$impeccable layout`

## Persona Red Flags

**Jordan (first-timer):** Apple Silicon, FCPXML, and OTIO lack plain-language translation. Jordan cannot confidently select a build or handle an OS block because there is no pre-download setup guide.

**Riley (skeptical evaluator):** The visible Export timeline button inside the hero is nonfunctional. “Verified editing engine” has no visible provenance, download size, or recovery guidance if setup fails.

**Casey (distracted mobile user):** Main navigation disappears on mobile, download requires a long scroll, and three tall cards plus a late caveat make a simple acquisition task feel heavy.

## Minor Observations

- Footer external links behave differently from comparable body links; make this deliberate and consistent.
- “Download free” lacks platform/file-size context before the chooser.
- “Early friends release” is appealing but unclear about support expectations.
- The hero visual's broadly labelled region contains a nonfunctional button-like element.

## Questions to Consider

- What proof would make a skeptical editor trust the “editable, not magic” promise before downloading?
- Could a transparent installation path reinforce the product's local, inspectable positioning instead of being a caveat?
- Which evidence would convince a producer that a two-hour interview is safe to process here?
