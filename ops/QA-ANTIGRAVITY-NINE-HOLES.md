# Antigravity QA run 4: a nine-hole round with three people at Four Bridges (user-experience pass)

A rehearsal of the real round: one organizer scoring a group of three (the organizer, a parent and a partner) over
the front nine of Four Bridges Country Club (pars from the club's scorecard). Gross scoring only: no net scores,
no per-player tees, no standings yet (see `docs/rounds-data-model.md` 2.1b for the mixed men/women design).
Run it the cheap way described in `QA-ANTIGRAVITY.md`: one fresh task, paste once, cheapest model that can drive the
browser, no follow-up chat, no real accounts. To keep it affordable the agent enters holes 1-3 and 9 in full and
skips 4-8 (a real round enters all of them; the screens are the same).

## The prompt (paste everything in the box)

```
You are QA-testing a Flutter web app at https://golf-live-scoring-app-510200.web.app using the browser.
Be economical: do NOT take screenshots unless a check fails or you cannot tell the state from page text. Prefer
reading page text / the accessibility tree. Do not retry a failed step more than twice; record FAIL and move on.
Do not ask me questions. Do not fix anything. Stop after the final report.

HOW THIS APP BEHAVES (read once, it will save you steps):
- It is a Flutter canvas app. On first load there is a hidden "Enable accessibility" button; activate it first,
  then elements have labels and can be found by name.
- To type: click the field first, THEN type. Typing without focusing a field goes to the wrong field. If a field
  ends up with extra text, select all and retype.
- Date fields open a calendar dialog when tapped: tap the day, then tap OK. Do not type into them.
- The screen can take 2-4 seconds to update after a tap; wait before judging a result. A tap made right after a
  previous tap is sometimes ignored: if a button press seems to do nothing, wait 2 seconds and press once more,
  and note "FLAKY TAP" with the step number (not a FAIL if the second press works).
- Use ONE browser and sign out/in to switch accounts. Create three NEW accounts (sign-up is on the sign-in
  screen, "Need an account? Create one"): qa-a-<random 4 digits>@example.test, qa-b-<same digits>@example.test and
  qa-c-<same digits>@example.test, password QaTest-12345. Do not reuse accounts or tournaments from earlier runs.
- Let T = today's date.
- THE SCORE TAB: inside a tournament the tabs are Overview, Teams, Players, Rounds, Score. The Score tab shows
  "Hole N . Par P", a row of hole number chips, one card per player in the group (with "Saved: N" or "No score
  yet", a - and + stepper starting at par, a big Save button, and a Pickup button that records the round maximum),
  Previous hole / Next hole buttons, and a Scoreboard table below (player, Thru, Tot, +/-, then one column per
  hole; a star after a number means pickup). The maximum score on a hole is double its par.
- A person scoring for others: anyone in the group may save a score for anyone in the group.

PART 1: SET UP (the organizer's experience; count your taps and note anything unclear)
1. Create account A, Profile tab, display name "QA Alpha". Tournaments > Create: name "Four Bridges Test",
   start T, end T. RECORD THE INVITE CODE. Open it, Rounds tab.
2. Add a round: name "Front 9", date T, Holes "Front 9", Largest group "3 players". Scroll to "Or enter your
   course": Course name "Four Bridges Country Club", Pars exactly:
   4 5 3 4 5 4 3 4 4 4 5 4 4 5 3 4 3 4
   Press Add round. Expect a card "Front 9 . <T>", "Front 9 . groups of up to 3" and
   "Course: Four Bridges Country Club (par 36)" (the nine holes it plays).
3. Sign out. Create account B, display name "QA Mom". Join with the code. Sign out. Create account C, display name
   "QA Partner". Join with the code. Sign out.
4. Sign in as A, open the tournament > Rounds > Set groups > "Fill from the roster, in order". Expect ONE group
   with three names (Alpha, Mom, Partner in some order).

PART 2: PLAY (as account A, on the Score tab)
5. Open Score. Expect "Hole 1 . Par 4", three player cards, and hole chips 1 to 9 ONLY (nine chips).
6. Hole 1 (par 4): save Alpha 4 (default value), Mom 5 (press + once), Partner 6 (press + twice). Expect each to
   say "Saved". Scoreboard: Alpha E, Mom +1, Partner +2.
7. Next hole: "Hole 2 . Par 5". Alpha 5 (default), Mom: press "Pickup (10)", Partner 6 (press + once).
   Expect "Saved: pickup (10)" for Mom and a "10*" under hole 2 in the Scoreboard.
8. Next hole: "Hole 3 . Par 3". Alpha 3 (default), Mom 4 (press + once), Partner: press "Pickup (6)".
   Then correct Alpha on the same hole: press - once on Alpha's card (shows 2) and press "Change to 2".
   Expect "Saved: 2".
9. Scoreboard after hole 3 must read: Alpha Thru 3, Tot 11, -1; Partner Thru 3, Tot 18, +6; Mom Thru 3, Tot 19,
   +7 (best to-par first). Write the rows exactly as shown.
10. Tap hole chip 9. Expect "Hole 9 . Par 4" and the "Next hole" button DISABLED (it is the last hole of this
    round). Save Alpha 4, Mom 5 (+ once), Partner 5 (+ once). Expect each "Saved".
11. Hole chips: exactly holes 1, 2, 3 and 9 show a check mark. Write which chips have one.
12. Scoreboard after hole 9 must read: Alpha Thru 4, Tot 15, -1; Partner Thru 4, Tot 23, +7; Mom Thru 4, Tot 24,
    +8. Write the rows exactly as shown.
13. Sign out. Sign in as B (Mom). Open the tournament > Score tab. Expect no round chooser, the same Scoreboard
    as step 12, and her own card marked "(you)". Go to hole 4 (Par 4), press "Save 4" on QA Mom's card only.
    Expect "Saved: 4" and her Thru to become 5.

PART 3: HOW IT FELT (answer from what you saw, not from guessing)
14. In your final report answer these, one or two sentences each:
    a. Roughly how many taps (not counting typing) did it take to set the whole round up (steps 1-4)? Which
       step felt slowest or most confusing?
    b. To record one hole for three players, how many taps did it take? Was it always obvious whose card was
       whose and which hole you were on?
    c. Was it clear what the maximum score was, and what "Pickup (N)" meant, without being told?
    d. When a save worked, was the feedback clear and fast enough? Anything that looked frozen?
    e. What would a golfer standing on a tee box with a phone in one hand want that is missing?
    f. Anything that looked wrong, ugly or surprised you.

FINAL REPORT: one table: step | PASS/FAIL | note. Then the exact Scoreboard rows from steps 9 and 12. Then the
FLAKY TAPs with step numbers. Then the answers to 14a-f. Include the invite code and the three emails.
```

## What each step proves

| Steps | Proves |
|-------|--------|
| 2 | A real course's 18 pars, a front-nine round, a group size of 3; the card shows par 36 for the nine holes it plays |
| 4-5 | Three-person group, the Score tab for a nine-hole round shows holes 1-9 only |
| 6-8 | Per-player entry, to-par ordering, pickups at the right maximum (10 on a par 5, 6 on a par 3), a correction |
| 9, 12 | Totals and +/- computed on the holes actually played (par of scored holes only), sorted by to-par |
| 10-11 | The last hole of a nine-hole round ends the Next button; check marks only on completed holes |
| 13 | A non-organizer scores for themselves and the live scoreboard is shared |
| 14 | The user-experience read the organizer asked for |

## Not covered

Mixed men's and women's tees and handicaps, net scores, offline entry (needs a phone), and the no-maximum setting.
