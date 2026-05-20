---
description: Auto work from PR_QUEUE.md safely and update PR_PROGRESS.md
argument-hint: [resume | auto-run | optional instruction]
allowed-tools: Read, Edit, Write, Grep, Glob, LS, TodoWrite, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(npm test:*), Bash(npm run test:*), Bash(npm run build:*), Bash(npx vitest:*), Bash(npx vitest run:*), Bash(pytest:*), Bash(node --version:*), Bash(node -e:*)
---

You are an autonomous coding assistant working safely on this project.

## Inputs

Read these files before doing anything:
@PR_QUEUE.md
@PR_PROGRESS.md

Optional instruction from user:
$ARGUMENTS

---

## Step 1 — Decide which PR to work on

1. If `$ARGUMENTS` contains "resume", look at PR_PROGRESS.md for `Current PR` and continue from where it left off.
2. Otherwise pick the **first** PR entry in PR_QUEUE.md where `Status:` is `pending` or `in_progress`.
3. If all PRs are `done`, `ready_for_review`, or `paused_by_limit`, output:
   > No actionable PR found. All done or waiting for human.
   and stop.
4. If the current PR in PR_PROGRESS.md has `Current status: ready_for_review`, stop immediately:
   > PR is ready_for_review — waiting for human review before proceeding.

---

## Step 2 — Work on the PR

For the selected PR:

- Read the Goal and Tasks listed in PR_QUEUE.md.
- Check Remaining work in PR_PROGRESS.md to know where to resume.
- Execute tasks one by one.
- After **each task**, update PR_PROGRESS.md immediately.
- Only work on **one PR per run**.

---

## Step 3 — Safety rules (non-negotiable)

- NEVER run: `git push`, `git push --force`, `npm publish`, `npx publish`, `rm -rf`, `rm -r`, `DROP TABLE`, `DELETE FROM`, `truncate`, `shred`
- NEVER read or write: `.env`, `.env.*`, `secrets/`, `*.key`, `*.pem`, `seed.txt`, `mnemonic*`, private keys
- NEVER execute real trades, real API calls with money, or real deployment
- NEVER bypass secrets detection or `.gitignore`
- If a task requires human judgment or an unsafe action → mark `Human approval: yes` and STOP

---

## Step 4 — Token/usage limit handling

If you notice you are approaching a context or usage limit (long conversation, slow responses, "limit" messages):

1. Stop immediately — mid-task is fine.
2. Write PR_PROGRESS.md with `Current status: paused_by_limit` and `Limit status: paused_by_limit — <reason>`.
3. List exactly what was completed and what remains in detail so the next run can resume cleanly.
4. Set the resume command block:
   ```
   Resume command: claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"
   ```
5. Do NOT attempt to squeeze in more work — clean state > partial work.

The persistent loop runner (`run-autowork-loop.sh`) will detect `paused_by_limit` in PR_PROGRESS.md and automatically wait 30 minutes before retrying. No manual intervention needed.

---

## Step 5 — Update PR_PROGRESS.md

Always write a complete PR_PROGRESS.md block after each run. Format:

```
## AutoWork Progress

Updated: <ISO timestamp>

Current PR: PR-XXX
Current status: <pending | in_progress | paused_by_limit | ready_for_review | done>

### Completed work
- <what was done this run>

### Remaining work
- <tasks still to do>

### Changed files
- <file paths changed>

### Tests run
- <test command and result, e.g. "npm test — 42 passed">

### Limit status
<clear | paused_by_limit — <reason>>

### Resume command
claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"

### Human approval needed
<yes — <reason> | no>

### Next action
<what happens next run>
```

---

## Step 6 — Update PR_QUEUE.md

Update the `Status:` field of the worked PR to match actual state:
- `in_progress` while working
- `ready_for_review` when all tasks are done and tests pass
- `done` only after human confirms (don't mark done yourself unless tests clearly pass and nothing risky remains)
