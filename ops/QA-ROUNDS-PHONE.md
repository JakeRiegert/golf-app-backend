# Phone QA: tournaments and rounds setup (R1)

Run these on your phone at https://golf-live-scoring-app-510200.web.app. They are the human checks for the
Rounds setup screens (add a round, set groups, tee times). The automated suites (35 unit, 223 emulator, 96 HTTP
tests) already cover the rules and edge cases; these checks cover what only a person sees: does it make sense,
does it fit the screen, is anything confusing.

**You need:** your phone, plus a second person or a second browser profile (or an incognito tab) with its own
account for sections C and E. Everything is on the real project, so name the test tournament "QA ..." and delete
nothing: leave it, it is harmless.

**How to report:** for each check say PASS, FAIL or CONFUSING. For a FAIL, send the check number, a screenshot, and
the exact wording of any red message. "CONFUSING" is a real result: if you had to think about what a button does,
that is a finding.

Time: about 20 minutes for A to D, 10 more for E and F.

## A. Sign in and get around (3 min)

| # | Do this | You should see |
|---|---------|----------------|
| A1 | Open the site, sign in | Two tabs at the bottom: **Tournaments** and **Profile**. The page starts at the top, not floating in the middle |
| A2 | Tap **Profile**, change the display name, tap Save | "Saved." and the name sticks after a reload |
| A3 | Tap **Tournaments** | Two buttons, **Create** and **Join**, each on one line, then "Your tournaments" |

## B. Create a tournament and find the pages (4 min)

| # | Do this | You should see |
|---|---------|----------------|
| B1 | Tap **Create**. Name it "QA Trip". Pick a start date and an end date 2 days later | The calendar opens on a tap. Days before the start date are greyed out in the end-date calendar |
| B2 | Tap **Create tournament** | A box with the invite code, **Copy code**, **Close**, **Open**. Tap **Copy code** and paste it somewhere to check |
| B3 | Tap **Open** | A page titled "QA Trip" with four tabs: Overview, Teams, Players, Rounds. Overview shows role "organizer", the dates, the invite code |
| B4 | Tap through all four tabs | Each is its own short page. Nothing is crammed together. Say which tab felt too busy, if any |

## C. Someone else joins (3 min, second person or profile)

| # | Do this | You should see |
|---|---------|----------------|
| C1 | Second account: **Join**, paste the code | "Joined QA Trip." and the tournament appears in their list |
| C2 | Second account: open it, tap **Rounds** | "No rounds yet." and **no** Add a round button (only admins add rounds) |
| C3 | You (organizer): **Players** tab | Both people on the roster |

## D. Rounds as the organizer (8 min) — the main event

| # | Do this | You should see |
|---|---------|----------------|
| D1 | **Rounds** tab, **Add a round**, tap Add round without a date | Red text: "Pick the date of the round" |
| D2 | Pick a date **inside** the tournament dates, leave 18 holes and the sample course on, tap **Add round** | "Round 1" card: 18 holes, groups of up to 4, "Course: Sample Course (par 72)", status "scheduled" |
| D3 | Add a second round with a date **outside** the tournament dates (a week later) | A box: "Widen the tournament dates? ... Everyone is told." Tap **Widen and continue**: the round appears and (on Overview) the end date has moved |
| D4 | Add a third round, choose **Front 9** | Card says 9 holes. Course par shows the front nine only (par 36 on the sample course) |
| D5 | Add a fourth round, choose **Back 9** | 9 holes, "par 36" again (the sample course is par 36 on each nine) |
| D6 | On Round 1 tap **Round settings**, change "Largest group" to 2 players, save | Card now says "groups of up to 2" |
| D7 | On Round 1 tap **Set groups** > **Fill from the roster, in order** | Groups appear, 2 people each at most, everyone on the roster exactly once, labeled "Group 1", "Group 2" |
| D8 | **Set groups** > **Fill from the roster, shuffled** | Same people, possibly different order. Everyone still appears exactly once |
| D9 | Tap a group. Set a tee time and a start hole (say hole 10) and Save | The group shows "Tee time ... (this phone's time) · starts on hole 10" |
| D10 | Tap that group again, choose **No tee time**, Save | The group says "No tee time" |
| D11 | Back on Round 1 pick **Set groups** > **Remove all groups** | "Groups (0)" and the help text again |

## E. What a player can and cannot do (5 min, second person)

| # | Do this (second account) | You should see |
|---|--------------------------|----------------|
| E1 | Open Rounds | All four rounds, groups visible, **no** Add a round, **no** Round settings, **no** Set groups |
| E2 | Look for their own group | Highlighted and labeled "(your group)" |
| E3 | Tap a group | Nothing editable happens |
| E4 | Organizer: on Round 1 set groups again; second account watches | The groups appear on their screen **without a refresh** |

## F. Visibility and edges (5 min)

| # | Do this | You should see |
|---|---------|----------------|
| F1 | Organizer: Overview > **Edit** > switch **Public** on, save. Third account (not on the roster, or an incognito profile): open the app. Is the tournament findable? | Spectators cannot find a tournament by browsing. They need the link/ID. Report what you see; this is an open product question, not a bug |
| F2 | Rotate the phone to landscape, and zoom the browser text up one notch | Nothing is cut off. Buttons stay tappable |
| F3 | Airplane mode on, open the Rounds tab you already visited, then off | The page still shows what it last had, and catches up when the network returns. Tapping **Add a round** offline should fail with a clear message, not hang |
| F4 | Tap **Add a round** twice quickly | One round, not two (the button disables while working) |

## G. Things you cannot see yet (so do not report them as missing)

- **The activity feed.** Round changes and moved tee times write feed events, but there is no feed screen. The
  automated tests check those events. A feed screen is a separate piece of work.
- **Scores.** No score entry exists yet (that is the next build step, R2). Course and holes are editable until the
  first score exists; that rule is covered by tests.
- **Disputes, review, finalize, results.** Designed, not built.

## H. Checked by the automated suites, no phone needed

Permission rules (a player cannot create rounds or groups even by calling the API directly), roster-only and
withdrawn-player groups, group-size limits, the shotgun start-hole rules, anonymous callers refused, scores and
disputes collections closed to everyone. If you want to re-run them: `npm run test:emulated`, `npm run test:http`
and `npm test` in `functions/`.

## Findings log

| Check | Result | Notes |
|-------|--------|-------|
| F3 offline (2026-11-12, real phone) | FAIL, then fixed | Showed raw "internal [0]". Now shows "Couldn't reach the server. Check your connection and try again." Verified on the phone after the fix. |
