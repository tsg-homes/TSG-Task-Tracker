---
name: tsg-thread-sync
description: Push this Claude thread's own instruction set (its CURRENT rules, consolidated, replacing the previous text) and its critical memories into the TSG Task Tracker's Rulesets under the thread's own entry, via the _Inbox patch protocol. The tracker mirrors General, then Code (code threads), then this thread into one Google Doc the thread reads back. Use when a thread has accumulated durable rules or facts worth surfacing, when Durand asks, or when he runs the consolidation pass across every thread (2026-09-22).
---

# TSG Thread Sync (revised 2026-09-22: instruction layers)

Source of truth for this skill is `skills/tsg-thread-sync/SKILL.md` in the `tsg-homes/TSG-Task-Tracker`
repo; Durand applies it in Cowork. The old version curled the exec URL: that path is dead under
DOMAIN access and the URL must never be written anywhere.

## The layers (Durand, 2026-09-22)

- **General** (`current.General` in the Rulesets file): the one merged set of rules applied everywhere. A thread NEVER edits it.
- **Code** (`current.Code`): Claude Code rules that sit on top of General. A thread never edits it either.
- **This thread** (`threads[<name>]`): the thread/project-specific rules that sit on top of General (and Code, when the thread is a code thread). This is the ONLY place a thread writes.

After every rulesets write the tracker rewrites one Google Doc per set in the tracker folder's
`Instructions` subfolder: `Systems — Instructions — Thread — <name>` holds General (+ Code for a
code thread) + this thread's instructions and memories, so the thread reads ONE Doc at start.
Only the latest instructions live in the tracker: older changelog lines are archived to
`History/rulesets-history-<ISO>.json` automatically. Do not write history into the instructions.

## 1. Read the current state

Search Drive for the Doc titled `Systems — Instructions — Thread — <name>` and read it
(`read_file_content`, it is a Google Doc). Its last two sections are this thread's current
instructions and memories. No Doc means the thread does not exist yet (use `add_thread`), or the
mirror has not run since the thread was added (wait a minute and search again). Never download
the Rulesets JSON for this: the Drive connector returns it base64-encoded and it is large.

## 2. Pick the thread name

Short, distinct, matching how Durand refers to the thread (Title Case, the NAMING rule: e.g.
"FUB Migration", "TSG Task Tracker"). Reuse an existing name exactly; never create a near-duplicate.

## 3. Consolidate, then write ONE patch per op

Instructions are ONE CURRENT SET, not a log: the full text of what this thread owns, does and
must never do, as it stands now (merge everything the thread has learned into it; drop anything
superseded). `update_thread_instructions` REPLACES the text, so send the whole consolidated set.
Memories are durable, load-bearing facts (corrections, standing decisions, structural gotchas)
that are not already obvious from the instructions; one `add_thread_memory` patch per new memory,
`remove_thread_memory` by index for one that is stale.

Via the Drive connector's `create_file`: `contentMimeType` `"application/json"`,
`disableConversionToGoogleType` `true`, `parentId` `"1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi"` (the
tracker's `_Inbox`), filename `thread-sync-<name>-<timestamp>.json`. Serialize with a real JSON
encoder and parse the exact text before upload (an unescaped quote files the patch as MALFORMED).

New thread (fails if the name exists):

```json
{"target":"rulesets","op":"add_thread","name":"<thread name>","instructions":"<the consolidated set>","memories":["<fact 1>","<fact 2>"],"ts":"<ISO>"}
```

Replace the instructions with the consolidated set:

```json
{"target":"rulesets","op":"update_thread_instructions","name":"<thread name>","instructions":"<the consolidated set>","ts":"<ISO>","historyEntry":{"summary":"<one line: what changed>"}}
```

Add one memory / remove one by index (index from the Doc's memory list, 0-based):

```json
{"target":"rulesets","op":"add_thread_memory","name":"<thread name>","memory":"<fact>","ts":"<ISO>"}
{"target":"rulesets","op":"remove_thread_memory","name":"<thread name>","index":0,"ts":"<ISO>"}
```

Mark a code thread (its Doc then carries the Code layer under General):

```json
{"target":"rulesets","op":"set_thread_code","name":"<thread name>","code":true,"ts":"<ISO>"}
```

Never send `set_category`, `append_category`, `replace_category_text` or `remove_category` from a
thread: General and Code are Durand's (Settings > Rulesets, or a patch he asks for).

## 4. Confirm and stop

The 1-minute trigger applies the patch and rewrites the thread's Doc. After a minute, search the
Doc by title again and confirm the new text is there; the patch file is trashed on success, a
failed one stays in `_Inbox` as `FAILED-`/`MALFORMED-` and is listed under Settings > General.
Tell Durand in one line what you pushed and give the Doc link on its own line.

## Rules

- Never write to the Rulesets or Data file directly; never curl or POST to the exec URL; never
  paste the exec URL or any token anywhere.
- One current set per thread; the tracker keeps history, the thread does not.
- Point the thread's own app-side instructions at its Doc (one line), never paste a copy.
