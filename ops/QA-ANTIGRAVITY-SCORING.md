# Antigravity QA run 3: play a round (score entry, pickups, corrections, scoreboard)

Deployed 2026-11-21: backend (score inbox, pickups recorded as the round maximum, no-maximum setting) and the
web app's Score tab. Run it the cheap way described in `QA-ANTIGRAVITY.md`: one fresh task, paste once, cheapest
model that can drive the browser, no follow-up chat, no real accounts.

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
  and note "FLAKY TAP" with the step number (do not count it as a FAIL if the second press works).
- Use ONE browser and sign out/in to switch accounts. Create two NEW accounts (sign-up is on the sign-in screen,
  "Need an account? Create one"): qa-a-<random 4 digits>@example.test and qa-b-<same 4 digits>@example.test,
  password QaTest-12345. Do not reuse accounts or tournaments from any earlier run.
- Let T = today's date. Tournament dates: T to T+2.
- THE SCORE TAB: inside a tournament, the tabs are Overview, Teams, Players, Rounds, Score. The Score tab shows
  "Hole N · Par P", a row of hole number chips, one card per player in the chosen group (with "Saved: N" or
  "No score yet", a - and + stepper, a big Save button, and a Pickup button), Previous hole / Next hole buttons,
  and a Scoreboard table below (player, Thru, Tot, +/-, then one column per hole; a star after a number means
  pickup). Saving takes up to about 5 seconds to show as "Saved". The scoring rule for this run: the maximum
  score on a hole is double its par (par 4 -> 8, par 3 -> 6, par 5 -> 10). A pickup is recorded as that maximum.

DO THESE IN ORDER. After each numbered step write one line: step number, PASS or FAIL, and for FAIL the exact
red message or what you saw instead.

ACCOUNT A (organizer)
1. Create account A. Profile tab: display name "QA Alpha", Save. Tournaments > Create: name "QA Round Test",
   start T, end T+2. RECORD THE INVITE CODE. Open it, Rounds tab.
2. Add a round: name "Scoring", date T. In the dialog scroll to "Or enter your course". Course name "QA Course".
   In Pars type exactly 17 numbers: 4 4 3 5 4 4 3 5 4 4 4 3 5 4 4 3 5. Press Add round. Expect a RED message saying
   to enter 18 pars (you entered 17) and the dialog still open.
3. Add the 18th par so the box reads: 4 4 3 5 4 4 3 5 4 4 4 3 5 4 4 3 5 4 . Press Add round. Expect a card
   "Scoring . <T>" and the text "Course: QA Course (par 72)".
4. Sign out.

ACCOUNT B (player)
5. Create account B, display name "QA Bravo". Tournaments > Join with the recorded code. Expect "Joined".
6. Sign out.

ACCOUNT A AGAIN
7. Sign in as A. Open the tournament > Rounds. On the card use Set groups > "Fill from the roster, in order".
   Expect one group with both players.
8. Open the Score tab. Expect: "Hole 1 . Par 4", two player cards (QA Alpha (you) and QA Bravo), both "No score
   yet", and each with a button "Save 4".
9. QA Alpha: press "Save 4". Wait up to 10 seconds. Expect "Saved: 4" on Alpha's card, and in the Scoreboard
   Alpha with Thru 1, Tot 4, +/- E. Go to the Rounds tab and back: the round's status should now say "live"
   (it starts automatically on the first score).
10. QA Bravo: press + once (shows 5), press "Save 5". Expect "Saved: 5"; Scoreboard Bravo Thru 1, Tot 5, +1,
    with the 5 on hole 1 shown in red.
11. Press "Next hole". Expect "Hole 2 . Par 4". On Alpha's card press + until the number is 9. Expect a RED
    message that says the score is over this round's maximum of 8 on a par 4, and the Save button disabled.
12. Press - once (8). Expect the red message gone and "Save 8" enabled. Press "Save 8". Expect "Saved: 8".
13. On Bravo's card press "Pickup (8)". Expect "Saved: pickup (8)". In the Scoreboard Bravo's hole 2 reads "8*".
14. Press "Next hole" to hole 3 (Par 3). On Alpha's card press "Pickup (6)". Expect "Saved: pickup (6)" and a
    "6*" in the Scoreboard under hole 3. Bravo: press - once (shows 2), press "Save 2". Expect "Saved: 2".
15. Correction: tap the hole chip "1". On Alpha's card press - once (3). The button should now read
    "Change to 3". Press it. Expect "Saved: 3". Scoreboard: Alpha's hole 1 now 3 and Tot = 3 + 8 + 6 = 17.
16. Hole chips: holes 1, 2 and 3 should each show a check mark inside the chip (both players have a score on
    them). Write which chips have a check.
17. Reload the browser page (F5). Wait for the app, sign in again if asked, open the tournament > Score tab. The
    Scoreboard must show the same numbers as step 15 (Alpha 3, 8, 6* = 17; Bravo 5, 8*, 2 = 15).
18. Sign out.

ACCOUNT B AGAIN
19. Sign in as B. Open the tournament > Score tab. Expect NO group/round chooser dropdown (B has one group and
    one round), B's own card marked "(you)", and the same Scoreboard numbers as step 17.
20. Go to hole 4 (Par 5). On QA Bravo's card press "Save 5". Expect "Saved: 5". Sign out.

ACCOUNT A, SECOND ROUND
21. Sign in as A. Rounds tab > Add a round: name "Back nine", date T+1 (tap the day in the calendar), Holes
    "Back 9", leave the sample course switch ON, leave the course boxes empty. Add round. Expect a second card.
22. On the Back nine card: Set groups > "Fill from the roster, in order".
23. Score tab. Use the Round dropdown to choose "Back nine". Expect the hole chips to be 10 to 18 only and the
    heading "Hole 10 . Par 4" (the sample course's hole 10 is a par 4). Press "Save 4" for QA Alpha. Expect
    "Saved: 4". Switch the dropdown back to "Scoring": its Scoreboard must be unchanged from step 20 plus
    Bravo's 5 on hole 4.

FINAL REPORT: one table: step | PASS/FAIL | note. Then the Scoreboard text exactly as you read it at steps 15,
17 and 23. Then a list of every FLAKY TAP with its step number. Then up to 5 bullets of anything confusing or
ugly (a message that is unclear, a label that surprised you, anything that took longer than 10 seconds).
Include the invite code and both emails.
```

## What each step proves

| Steps | Proves |
|-------|--------|
| 2-3 | A hand-entered course (name and 18 pars) is checked, saved and shown with its par total |
| 7-9 | Group setup, the Score tab opens on the first unfinished hole, a score reaches the official record, the round starts itself on the first score |
| 10-12 | Per-player entry, the over-maximum block on the screen, a score at exactly the maximum is accepted |
| 13-14 | Pickups are recorded as the round maximum for that hole's par (8 on a par 4, 6 on a par 3) and shown with a star |
| 15 | A correction is a newer entry and the latest one counts; totals and the scoreboard follow |
| 16-17 | Hole completion marks; the data comes from the server, not the page (survives a reload) |
| 19-20 | A player (not the organizer) sees the same live numbers and can score for their own group |
| 21-23 | A back-nine round: holes 10 to 18 only, rounds keep separate scoreboards, the round chooser works |

## Not covered by this run (needs a phone or someone else)

- Offline entry (no signal) and unsent scores surviving a closed tab.
- The server turning away a score (a removed player, a score after the round is final): there is no way to set
  those up from the screens alone, so they are covered by our own scripted production check.
- The "no maximum" tournament setting (no screen for it yet) and net scores or standings (not built).

## Things to know when reading the results

- Server-side, every score leaves a `submission_processed` log line with the outcome and the time it took; the
  checks of the logs against this run are done on our side, not by the agent.
- The test tournament and the two accounts can be deleted afterwards on our side (see `ops/DEPLOY.md`).
