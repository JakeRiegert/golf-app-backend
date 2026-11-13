# Antigravity QA run 2: round names, play-order labels, delete round, dates rule

Re-test of what changed after the first run (see `QA-ANTIGRAVITY.md` for how to run it cheaply: one fresh task,
paste once, cheapest model that can drive the browser, no follow-up chat, no real accounts). This run covers
only the new behavior plus the one thing the first run did not try (shrinking the group size below an
existing group).

Deployed 2026-11-12 evening: backend (17 functions) and web app.

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
- The screen can take 2-4 seconds to update after a tap; wait before judging a result.
- Use ONE browser and sign out/in to switch accounts. Create two NEW accounts (sign-up is on the sign-in screen,
  "Need an account? Create one"): qa-a-<random 4 digits>@example.test and qa-b-<same 4 digits>@example.test,
  password QaTest-12345. Do not reuse accounts or tournaments from any earlier run.
- Let T = today's date. Tournament dates: T+14 to T+16. Round dates below are relative to T.
- Round cards show a title, then a date, like "Practice · 2026-11-27". An unnamed round is titled "Round N",
  where N is its position when the rounds are listed by date (earliest first; same-day rounds keep the order
  they were added in). The list order on screen is that order.

DO THESE IN ORDER. After each numbered step write one line: step number, PASS or FAIL, and for FAIL the exact
red message or what you saw instead. Where a step says LIST, also write the card titles top to bottom, with dates.

ACCOUNT A
1. Create account A. Profile tab: display name "QA Alpha", Save. Tournaments > Create: name "QA Trip 2",
   start T+14, end T+16, Create tournament. RECORD THE INVITE CODE. Tap Open > Rounds tab.
2. Add a round: Name "Practice", date T+15, leave the rest. Expect the card title "Practice · <T+15>". LIST.
3. Add a round: no name, date T+15. Expect title "Round 2". LIST (Practice first, then Round 2).
4. Add a round: no name, date T+14 (earlier, inside the tournament dates). Expect it to appear FIRST, titled
   "Round 1", with Practice second and the other T+15 round now titled "Round 3". LIST.
5. Round settings on "Practice": clear the Name field to empty, Save. Expect its title to become "Round 2" and the
   list to read Round 1, Round 2, Round 3. LIST.
6. Round settings on the last card: set Name "Friday AM", Save. Expect its title "Friday AM". LIST.
7. Add a round dated T+25 (outside the dates), name "Extra". Expect the box "Widen the tournament dates?";
   tap "Widen and continue". Expect "Extra · <T+25>" at the bottom. Open the Overview tab: end date must now be T+25.
8. Overview > Edit: set the End date to T+16, Save. Expect this to be REFUSED with red text that mentions "Extra",
   its date (T+25), and says to move or delete that round first. The Overview end date must still be T+25. Record
   the exact message.
9. Rounds tab: on the "Extra" card tap Delete, confirm. Expect "Round deleted." and the card gone. LIST (4 cards).
10. Overview > Edit: set the End date to T+16, Save. Expect success; Overview shows end date T+16.
11. Sign out (Profile tab).

ACCOUNT B
12. Create account B, display name "QA Bravo". Tournaments > Join with the recorded code. Expect "Joined".
13. Open the tournament > Rounds. LIST must match the step-9 list exactly (same titles, same order). Expect NO
    "Add a round", NO "Round settings" and NO "Delete" anywhere. Sign out.

ACCOUNT A AGAIN
14. Sign in as A. On the FIRST card (Round 1) use Set groups > "Fill from the roster, in order". Expect one
    group with both players.
15. On that same card: Round settings > Largest group = 1 player > Save. Expect it to be REFUSED with red text like
    "Group 1 has 2 players, more than 1. Move players first." Record the exact message. The card must still say
    "groups of up to 4" (or whatever it said before).
16. On that same card tap Delete, confirm. Expect "Round deleted." and the card gone, even though it had a group.
    LIST (3 cards). The remaining cards' titles must be re-labeled by position (Round 1, Round 2, Friday AM or
    whichever applies); record exactly what they say.
17. Sign out, sign in as B, open the tournament > Rounds: LIST must match step 16. Round 1 must be gone for B too
    (no refresh needed beyond reopening the tab).

FINAL REPORT: one table: step | PASS/FAIL | note. Then the LISTs for steps 2-6, 9, 13, 16 and 17 together, so I
can compare them. Then up to 5 bullets of anything confusing or ugly (a message that is unclear, a label that
surprised you). Include the invite code and both emails.
```

## What each step proves

| Steps | Proves |
|-------|--------|
| 2-6 | Names are stored and shown, an unnamed round is labeled by position, a round added for an earlier day slots in first without renaming stored data, clearing a name goes back to the position label |
| 7-10 | Widening still works; narrowing the tournament dates past a round is refused with a message naming the round; deleting the round (or the round being gone) makes narrowing possible |
| 9, 16 | Delete round, with and without groups; the list relabels |
| 13, 17 | A player sees the same order, names and labels, has no admin controls, and sees a deleted round disappear |
| 15 | The shrink-group-size refusal the first run did not exercise |

## Things to know when reading the results

- The refusal message in step 8 and the "Round N" it quotes come from the server, which numbers rounds by the
  order they were added. The cards show position in play order, so the two can differ ("Round 4" in the message
  against a card titled "Round 3"). The date in the message always identifies the round. This is a known wrinkle;
  report what you see.
- Server-side, every action in this script leaves a log line; the checks of the logs against this run are done on
  our side, not by the agent.
