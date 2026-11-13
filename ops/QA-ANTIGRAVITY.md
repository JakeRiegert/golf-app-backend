# Antigravity QA run (one prompt, low token use)

Goal: have Antigravity's browser agent do the repeatable part of `QA-ROUNDS-PHONE.md` in **one run**, and leave
the few things that need a real phone to you (about 3 minutes, listed at the bottom).

## Before you start (2 minutes, saves the most tokens)

1. **One run, one prompt.** Paste the block below once, then do not chat with the agent. Every follow-up message
   re-sends the whole conversation.
2. **Use the cheapest model that can drive the browser.** This is a checklist, not a reasoning task.
3. **Make a fresh task/conversation** for it (no old context loaded).
4. **Do not give it your real Google account or any real password.** It makes two throwaway email-and-password
   accounts itself. Google sign-in is not tested here (it is a button, and Google blocks scripted logins).
5. Run it against the live test site: https://golf-live-scoring-app-510200.web.app. It leaves a few harmless
   "QA" tournaments behind; nothing to clean up.

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
- Two test accounts are needed. Account A is the organizer, account B is a player. Use ONE browser; sign out
  and in to switch. Emails: qa-a-<random 4 digits>@example.test and qa-b-<same 4 digits>@example.test,
  password: QaTest-12345 . Sign-up is on the sign-in screen: "Need an account? Create one".
- Dates: use today's date as T. Tournament dates: T+14 to T+16.

DO THESE IN ORDER. After each numbered step write one line: step number, PASS or FAIL, and for FAIL the exact
red message or what you saw instead.

ACCOUNT A
1. Create account A. Expect: the home screen with a bottom bar with two tabs, "Tournaments" and "Profile", and
   two buttons "Create" and "Join".
2. Profile tab: set display name "QA Alpha", Save. Expect the text "Saved."
3. Tournaments tab > Create. Name "QA Trip". Start T+14, end T+16 (end-date calendar must grey out days before
   the start). Create tournament. Expect a box with an invite code. RECORD THE CODE. Tap Open.
4. Expect four tabs: Overview, Teams, Players, Rounds. Overview must show role "organizer" and the dates.
5. Rounds tab > Add a round, tap Add round with no date. Expect red text "Pick the date of the round".
6. Pick date T+15 (inside the tournament), keep 18 holes and the sample course, Add round. Expect a card
   "Round 1", 18 holes, "groups of up to 4", "Sample Course (par 72)", status "scheduled".
7. Add a round dated T+25 (outside). Expect a box "Widen the tournament dates?". Tap "Widen and continue".
   Expect Round 2 to appear.
8. Add a round with "Front 9", date T+15. Expect 9 holes and "par 36". Add another with "Back 9": 9 holes, "par 36".
9. Round 1 > Round settings > Largest group = 2 players > save. Expect "groups of up to 2".
10. Players tab: expect only QA Alpha (organizer) on the roster. Then Sign out (Profile tab).

ACCOUNT B
11. Create account B. Profile: display name "QA Bravo".
12. Tournaments > Join > enter the recorded code > Join. Expect "Joined QA Trip." and it appears in the list.
13. Open QA Trip > Rounds. Expect all 4 rounds listed and NO "Add a round" button and NO "Round settings".
14. Overview: role must say "player". There must be no Edit and no Start button. Sign out.

ACCOUNT A AGAIN
15. Sign in as A. QA Trip > Players: expect both QA Alpha and QA Bravo.
16. Rounds > Round 1 > "Set groups" > "Fill from the roster, in order". Expect 1 group with both people (Round 1
    allows 2 per group), labeled "Group 1" and "(your group)" for A.
17. Tap the group. Set a tee time (any) and start hole 10, Save. Expect "starts on hole 10" and a tee time on the group.
18. Tap the group again, choose "No tee time", Save. Expect "No tee time".
19. Set groups > "Fill from the roster, shuffled": still both people, exactly once each.
20. Set groups > "Remove all groups". Expect "Groups (0)".
21. Round 1 > Set groups > fill in order again (leave the groups in place). Sign out.

ACCOUNT B AGAIN
22. Sign in as B. QA Trip > Rounds > Round 1: the group must be visible and marked "(your group)". Tapping it
    must not open anything editable.

FINAL REPORT: one table: step | PASS/FAIL | note. Then one line: anything that looked confusing or ugly
(spacing, cut-off text, wrapped buttons), max 5 bullets. Include the QA Trip invite code and both emails.
```

## What this costs you

- **Your effort:** paste once, wait, read the table. About 5 minutes of your time.
- **Tokens:** the agent reads page text instead of screenshots, goes in one pass and does 22 checks. The
  instructions about focusing fields and the accessibility button exist because without them an agent typically
  retries a lot on this kind of app.
- **If something fails**, do not re-run the whole thing. Paste only the failing step numbers into a new short
  prompt that repeats the "HOW THIS APP BEHAVES" block and the signed-in steps it needs, or send me the table and I
  will reproduce it myself against the local emulators.

## Left for your phone (about 3 minutes, not worth agent tokens)

| # | Check |
|---|-------|
| P1 | Landscape, and browser text zoomed up one notch: nothing cut off, buttons tappable |
| P2 | Airplane mode on the Rounds tab you already opened, then off: the page keeps what it had and catches up; "Add a round" offline fails with a clear message instead of hanging |
| P3 | Two devices signed in at once (you as organizer, the test player account on a second device or profile): set groups on one, the other updates with no refresh |
| P4 | Does it feel less overwhelming than before? (Honest gut reaction: which tab still feels too busy?) |

## Covered by the automated tests, so not here

Permission rules when calling the API directly, group-size and roster limits, shotgun start-hole rules,
anonymous callers refused, scores/disputes collections closed to everyone.
