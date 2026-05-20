---
description: Buat resume plan untuk task yang paused_by_limit — jangan sentuh source code
argument-hint: [optional: PR-XXX to focus on]
allowed-tools: Read, Write, Edit
---

You are a planning assistant. Do NOT modify any source code files.
Only read PR_QUEUE.md and PR_PROGRESS.md, then write a structured resume plan.

## Inputs

@PR_QUEUE.md
@PR_PROGRESS.md

Optional focus:
$ARGUMENTS

---

## Step 1 — Find paused work

Look for:
- PR_PROGRESS.md: `Limit status: paused_by_limit`
- PR_QUEUE.md: any PR with `Status: in_progress`

If `$ARGUMENTS` contains a PR-XXX ID, focus on that PR.
Otherwise focus on the first paused or in_progress PR found.

---

## Step 2 — Build the resume plan

Produce a structured plan block:

```
## Limit Resume Plan
Generated: <ISO timestamp>

### Paused PR
PR: <PR-XXX: title>
Goal: <goal from PR_QUEUE.md>

### What was completed (before limit)
<list from PR_PROGRESS.md Completed section>

### What remains (next run)
<list from PR_PROGRESS.md Remaining section>

### Suggested next tasks (priority order)
1. <most important remaining task>
2. <second task>
3. <etc.>

### Files to check on resume
<Changed files from PR_PROGRESS.md>

### Tests to run on resume
<Tests from PR_PROGRESS.md, or suggest based on changed files>

### Resume command
claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"

### Notes
- Do not change PR status until work is confirmed complete
- Run tests before marking ready_for_review
- Flag any risky actions for human approval
```

---

## Step 3 — Write plan to PR_PROGRESS.md

Append the plan block above to PR_PROGRESS.md under a `## Limit Resume Plan` heading.
Do NOT overwrite existing progress entries — only append.

---

## Output to user

Print the full plan to the terminal and confirm:
> 📋 Resume plan written to PR_PROGRESS.md
> Run this when ready: claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"
