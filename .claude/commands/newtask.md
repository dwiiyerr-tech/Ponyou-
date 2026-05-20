---
description: Tambahkan task baru ke PR_QUEUE.md langsung dari prompt
argument-hint: <deskripsi task — contoh: Build daily PnL dashboard>
allowed-tools: Read, Write, Edit
---

You are a task manager. Add a new PR entry to PR_QUEUE.md.

## Input

Task description from user:
$ARGUMENTS

---

## Step 1 — Read PR_QUEUE.md

@PR_QUEUE.md

Find the highest existing PR-XXX number. New PR ID = that number + 1.
If no entries exist, start at PR-001.

---

## Step 2 — Build the new PR entry

Use this format exactly:

```
## PR-XXX: <short title from $ARGUMENTS>
Status: pending
Priority: medium
Goal: $ARGUMENTS
Safety: safe
Tasks:
- [ ] (fill in when working)
Added: <ISO date>
```

---

## Step 3 — Append to PR_QUEUE.md

Add the new entry at the **bottom** of PR_QUEUE.md.
Do not modify any existing entries.

---

## Step 4 — Update PR_PROGRESS.md

@PR_PROGRESS.md

Append a short note:

```
## New task added: PR-XXX
Status: pending
Goal: <from $ARGUMENTS>
Added: <ISO date>
```

Do not overwrite any existing in_progress PR status.

---

## Output

Confirm to user:
> ✅ Added PR-XXX: <title>
> Status: pending
> Run `/autowork` to start working on it.
