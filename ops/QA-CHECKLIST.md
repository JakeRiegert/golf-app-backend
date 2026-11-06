# Manual QA checklist

Everything the app can do today that has **not** been checked by hand yet, in the order that is
easiest to work through. It excludes what you already verified live (Google sign-in, profile
creation, creating a tournament, "Your tournaments", adding teams, joining by code with a second
account, picking and assigning teams and handicaps, Start locking handicaps and teams, Reopen,
Edit and the public switch, granting co-admin, and a 21st team) and what only automation can check
(see the last section).

**Setup (once)**
- Run the app: `http://localhost:5000` (against the live Google Cloud backend).
- Window A: your normal Chrome, signed in with Google (the organizer).
- Window B: an Incognito window with a throwaway email/password account (a player).
- Window C: a second Incognito window or another browser profile, a third account that never joins
  anything (the stranger).
- Everything you create is real data in the live project. Use throwaway names.

Format: **Title**. **Do** what to click. **Expect** the result at a high level.

## Results of the automated browser run (2026-11-05)

An AI browser agent ran 38 scenarios from sections A to H against the live app on localhost:
35 passed, 3 failed. The production logs for the same window show 106 backend calls and zero server
errors. The failures were all in the client:

- **C2:** typing `abc` into the Edit dialog's wager pot silently cleared the pot (`num.tryParse` gave
  null, which was sent as "no pot"). **Fixed & Re-verified:** it now shows "Wager pot must be a number from 0 to
  100000", keeps the dialog open, and sends nothing.
- **E3:** typing `abc` into a handicap box silently cleared the handicap, for players and admins.
  **Fixed & Re-verified:** it now shows "Handicap must be a number from -10 to 54" and sends nothing. An empty box
  still clears.
- **F5:** double-clicking a dialog button popped the page underneath and left a blank white screen
  (Start/Reopen confirm, Edit, Rename). **Fixed & Re-verified:** dialogs close through `popDialog`, which ignores a
  second close while the dialog is animating out.
- Minor: the Public switch on the create form did not reset after creating. **Fixed & Re-verified.**

All 38 automated browser scenarios across sections A to H are now verified and checked off (`38 / 38 PASS`).
The remaining unchecked boxes were not testable by the agent (A7 needs a real Gmail, H3 needs an hour, H5
is a feel check, H7 needs other browsers) or are console and pipeline setup tasks (I and J).

## A. Accounts and profile

- [x] **A1. Email and password sign-up.** *Do:* in window B, click "Need an account? Create one", enter a new email and a password, submit. *Expect:* you land on the home screen signed in; the profile shows "Creating your profile..." then fills in; the email appears under "Email (private, only you can read this)"; the display name is empty because email accounts have no Google name.
- [x] **A2. Sign out and back in.** *Do:* click "Sign out" (top right), sign in again with the same email and password. *Expect:* the same uid as before, the same "Created" time, and "Updated" moves forward.
- [x] **A3. Wrong password and bad email.** *Do:* try a wrong password, then a malformed email, then an empty form. *Expect:* a clear error message each time, you stay on the sign-in screen, nothing crashes.
- [x] **A4. Session survives a reload.** *Do:* reload the page while signed in (Ctrl+Shift+R); then sign out and reload again. *Expect:* still signed in after the first reload; the sign-in screen after the second.
- [x] **A5. Edit the display name.** *Do:* change "Display name" and click "Save display name"; look at the roster in the other window. *Expect:* it saves, "Updated" changes, "Created" does not, and the new name shows on your roster row in every window instead of "Player xxxxxx".
- [x] **A6. Display name limits.** *Do:* save it blank, then with 60 characters. *Expect:* a clear error (1 to 50 characters) and the old name is kept.
- [ ] **A7. Google and password with the same email.** *Do:* with a throwaway Gmail you control, create an email/password account, sign out, then "Continue with Google" with the same address (or the reverse). *Expect:* either one linked account (same uid, same profile) or a clear message; note exactly what happens, there should never be two profiles for one person. (Exploratory.)

## B. Creating and joining tournaments

- [x] **B1. Date pickers (new).** *Do:* in "Create a tournament", tap "Start date" (a calendar opens), pick a day; tap "End date" (days before the start are greyed out), pick a later day; use the x to clear one; use the calendar icon to reopen. *Expect:* fields show `YYYY-MM-DD`, the end date can never be before the start, clearing empties the field, and the calendar opens on the date already chosen.
- [x] **B2. Create with dates and Public on.** *Do:* name, both dates, toggle "Public", click "Create tournament". *Expect:* a green "Created ... invite code ..." line; the card shows "public - active - not started" with the dates; the form clears.
- [x] **B3. Create with no dates.** *Do:* name only. *Expect:* created as private with no date range on the card.
- [x] **B4. Create validation.** *Do:* try a blank name, a name of 101 characters. *Expect:* a clear error message and nothing is created.
- [x] **B5. Join with sloppy input.** *Do:* in window B, type the invite code in lower case with spaces around it, click "Join tournament". *Expect:* "Joined ..." appears; the tournament shows up in window B's list live, and window A's roster shows the new player without a refresh.
- [x] **B6. Join twice.** *Do:* submit the same code again. *Expect:* "You are already in ..."; the roster has no duplicate.
- [x] **B7. Wrong and blank invite codes.** *Do:* join with `NOPE1234`, with a code containing a slash, and with an empty box. *Expect:* a clear "no match" or "required" error each time; nothing joined; the app still works.
- [x] **B8. Two tournaments, two views.** *Do:* as the organizer create a second tournament; have window B join only the first. *Expect:* each person sees exactly their own tournaments with the right role ("You: organizer" or "You: player").

## C. Editing a tournament

- [x] **C1. Edit everything.** *Do:* as organizer click "Edit"; the date fields open prefilled; change the name, pick new dates, enter a wager pot of `250.456`, toggle Public, Save. *Expect:* the card updates live in both windows; the pot is stored as 250.46.
- [x] **C2. Edit validation.** *Do:* in Edit, clear the name; enter a pot of `-5`, `100001` and `abc`. *Expect:* clear errors, and the card keeps its old values.
- [x] **C3. Clearing dates.** *Do:* in Edit, clear both dates with the x, Save. *Expect:* the card shows no dates.
- [x] **C4. A player cannot edit.** *Do:* look at the card in window B. *Expect:* no Edit, Start, Reopen or "Make co-admin" buttons, and the team add and rename controls are absent.

## D. Teams

- [x] **D1. Add a team with a bad color or no name.** *Do:* try a color of `teal`, then `#12345`, then a blank name. *Expect:* a clear error ("color must look like #1A7F37" or "team name is required"); no team is created.
- [x] **D2. Rename.** *Do:* click "Rename" on a team and save a new name. *Expect:* the new name shows on the teams list, in every team dropdown and in all windows; players keep their team.
- [x] **D3. Duplicate team names.** *Do:* add "red" when "Red" exists; rename a team to another team's name. *Expect:* an "already exists" error each time; no duplicate.

## E. Players before the tournament starts

- [x] **E1. A player picks, changes and leaves a team.** *Do:* in window B choose Red, then Blue, then "No team". *Expect:* each saves; the caption says "Team chosen by the player"; "No team" clears it; window A sees each change live.
- [x] **E2. A player sets a handicap.** *Do:* type `12.34` and click the check mark; then clear the box and click the check. *Expect:* it saves as 12.3 with "Handicap entered by the player"; clearing removes it.
- [x] **E3. Handicap limits.** *Do:* try `-11`, `55`, `abc`, then `54` and `-10`. *Expect:* the first three are refused with a message; the last two are accepted.
- [x] **E4. Admin sets a player's team and handicap.** *Do:* in window A set a team and a handicap on a player's row. *Expect:* captions say "set by the organizer"; in window B the team dropdown is disabled; the handicap box still lets the player overwrite it (last write wins) until the start.
- [x] **E5. Admin hands the team back.** *Do:* in window A set that player's team to "No team". *Expect:* the player's dropdown is enabled again.

## F. Start, Reopen and the locks

- [x] **F1. Cancel and confirm.** *Do:* click "Start", then "Cancel" in the dialog; then click "Start" and confirm. *Expect:* cancel changes nothing; confirming marks the card "started" and the button becomes "Reopen".
- [x] **F2. What players see after the start.** *Do:* look at window B. *Expect:* the handicap shows "HCP n (locked)" and the team dropdown is disabled with "(locked: tournament started)".
- [x] **F3. Admins can still edit.** *Do:* in window A change a player's team and handicap after the start. *Expect:* both save; window B updates live.
- [x] **F4. Reopen unlocks.** *Do:* click "Reopen" and confirm. *Expect:* window B can edit its team and handicap again.
- [x] **F5. Double-click.** *Do:* double-click "Start" in the confirm dialog quickly. *Expect:* it starts once with no error.

## G. Co-admin

- [x] **G1. What a co-admin can do.** *Do:* make window B the co-admin; from B rename a team, add a team, edit the tournament, change another player's team and handicap, Start and Reopen. *Expect:* every action works and window A updates live; B's card says "You: co-admin".
- [x] **G2. Replace the co-admin.** *Do:* join a third player and make that one co-admin. *Expect:* the first loses the admin controls immediately and the new one gains them, live.
- [x] **G3. Remove the co-admin.** *Do:* click "Remove co-admin". *Expect:* their admin controls vanish; the organizer is unaffected.

## H. Across the whole app

- [x] **H1. A stranger sees nothing.** *Do:* in window C (never joined) sign in. *Expect:* "Your tournaments" is empty; nothing from your tournaments is visible anywhere.
- [x] **H2. Live updates.** *Do:* make any change in one window and watch the other. *Expect:* it appears within a few seconds with no refresh.
- [ ] **H3. A long session.** *Do:* leave a window signed in for over an hour, then act (add a team). *Expect:* it works without signing in again.
- [x] **H4. A dropped connection.** *Do:* in Chrome DevTools, Network, choose Offline, click an action, then go back Online. *Expect:* a clear error and no frozen buttons; after reconnecting the lists catch up and the next action works.
- [ ] **H5. Cold starts.** *Do:* after the app has been idle a while, take an action. *Expect:* it may take a few extra seconds the first time, the button shows it is busy, nothing is submitted twice.
- [x] **H6. A narrow screen.** *Do:* make the browser about 375 pixels wide. *Expect:* no overlapping or cut-off controls; the forms, dropdowns and the calendar are usable.
- [ ] **H7. Another browser.** *Do:* repeat sign-in (email), create a tournament and pick a date in Firefox or Edge, and Safari if you have it. *Expect:* the same behavior.

## K. Removing players and deleting teams (new; needs the functions deployed first)

- [ ] **K1. Remove a player before the start.** *Do:* as organizer click "Remove" on a player's row and confirm. *Expect:* the row disappears live; in that player's window the tournament vanishes from "Your tournaments"; they can rejoin with the invite code.
- [ ] **K2. Remove a player after the start.** *Do:* Start the tournament, then "Remove" a player and confirm. *Expect:* their row stays, struck through with "- withdrawn", and its controls are disabled; their window can no longer change a team or handicap.
- [ ] **K3. Who can remove.** *Do:* look at each row as organizer, as co-admin and as a player. *Expect:* admins see "Remove" on every row except the organizer's and their own; a player sees no Remove buttons.
- [ ] **K4. Removing the co-admin.** *Do:* make a player co-admin, then Remove them. *Expect:* they come off the roster and lose the admin controls.
- [ ] **K5. Delete a team before the start.** *Do:* put two players on "Red" (one by their own choice, one assigned by you), click "Delete" next to Red and confirm. *Expect:* Red disappears, both players show "No team", and the player you assigned can pick a team again.
- [ ] **K6. Delete a team after the start.** *Do:* Start; try to Delete a team with players on it, then an empty one. *Expect:* the first is refused with "Move the N player(s) off this team first" and nothing changes; the empty team is deleted.
- [ ] **K7. Cancel the confirmation.** *Do:* click Remove or Delete, then Cancel. *Expect:* nothing changes.

## I. In the Google Cloud and Firebase consoles

- [ ] **I1. Production logs are clean.** *Do:* Firebase console, Functions, Logs, or Cloud Logging with severity of warning or higher, after your testing. *Expect:* only the expected warnings from your negative tests (permission-denied, invalid-argument, not-found, already-exists); no ERROR lines.
- [ ] **I2. Usage and cost.** *Do:* Firestore, Usage, and Functions, Dashboard. *Expect:* small read and write numbers, no error spikes; note them for the cost baseline.
- [ ] **I3. Budget alert.** *Do:* Google Cloud console, Billing, Budgets and alerts, create a 10 USD budget on this project with alerts at 10, 50 and 100 percent to your email. *Expect:* the budget is listed. (A setup task that is still outstanding.)
- [ ] **I4. Feed indexes finished building.** *Do:* Firebase console, Firestore, Indexes, composite. *Expect:* the two `activity` indexes show "Enabled" (they were still building after the deploy).

## J. The deploy pipeline (when you set it up)

- [ ] **J1. GitHub variables.** *Do:* add `GCP_PROJECT_ID`, `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT` and `FIREBASE_API_KEY` as repository variables (values in `ops/DEPLOY.md`), and re-run `.\ops\setup-wif.ps1`.
- [ ] **J2. First pipeline run.** *Do:* Actions, "Deploy to Google Cloud", Run workflow, scope `all`. *Expect:* it deploys, the smoke test passes, and the run is green.
- [ ] **J3. A second run deploys nothing.** *Do:* run it again with scope `changed`. *Expect:* it reports it has nothing to deploy and finishes quickly.

## Not testable by hand yet (automation covers these)

- **The activity feed.** It exists in the backend and is deployed, but there is no screen yet. The tests cover who sees which events.
- **Spectating a public tournament.** There is no screen to find a public tournament, so a stranger cannot reach one by hand. The tests cover what a spectator can and cannot read.
- **Reading another player's email.** No screen tries it; the tests and the smoke test do.
- **The 100-team and 400-player caps, a suspended tournament, and two admins editing at once.** Too slow or impossible to set up by hand; the tests cover them.
