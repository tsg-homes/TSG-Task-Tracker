---
name: tsg-workstream-sync
description: Push this workstream's own instruction set (its CURRENT rules, consolidated, replacing the previous text) and its critical memories into the TSG Task Tracker Rulesets under the workstream's own entry, via the _Inbox patch protocol. The tracker mirrors General, then Code (code workstreams), then this workstream into one Google Doc the workstream reads back. Use when a workstream has accumulated durable rules or facts worth surfacing, when Durand asks, or during a consolidation pass across every workstream. Formerly tsg-thread-sync.
---

# TSG Workstream Sync (revised 2026-09-23: threads renamed to workstreams)

Source of truth for this skill is `skills/tsg-workstream-sync/SKILL.md` in the
`tsg-homes/TSG-Task-Tracker` repo; Durand saves it to his account from Cowork. It replaces
`tsg-thread-sync` (same job, new terms). The exec URL is never used and must never be written
anywhere.

Terms (General rules, STANDARD TERMS): a **workstream** is an ongoing body of work with a permanent
ID (`T###`) and its own entry in the Task Tracker Rulesets (formerly "thread"; one Claude Project per
workstream). A **session** is one Claude conversation.

## The layers

- **General** (`current.General` in the Rulesets file): the one merged set of rules applied everywhere. A workstream NEVER edits it.
- **Code** (`current.Code`): Claude Code rules on top of General. A workstream never edits it either.
- **This workstream** (`workstreams[<name>]`, carrying an immutable server-assigned `id` such as `T018`): the workstream-specific rules that sit on top of General (and Code, when it is a code workstream). This is the ONLY place a workstream writes. The ID is generated when the workstream is created and never changes; sessions identify their workstream by ID, never by title.

After every rulesets write the tracker rewrites one Google Doc per set in the tracker folder's
`Instructions` subfolder: `Systems — Instructions — Workstream — <id> — <name>` holds General
(+ Code for a code workstream) + this workstream's instructions, memories, links and latest
sessions, so a session reads ONE Doc at start. The Doc title and its first line
(`SYSTEMS — INSTRUCTIONS — WORKSTREAM <id>: <name>`) carry the ID. Doc file ids never change when
a workstream is renamed. Only the latest instructions live in the tracker: older changelog lines are
archived to `History/rulesets-history-<ISO>.json` automatically. Do not write history into the
instructions.

## 1. Read the current state and learn your ID

If the session already knows its workstream ID (the Claude Project's instructions name it, an
earlier sync, or Durand), search Drive for the Doc whose title contains `Workstream — <id>` (for
example `Workstream — T018`) and read it (`read_file_content`; it is a Google Doc). Otherwise search
by name: `Systems — Instructions — Workstream — ` + the workstream name. Record the ID: every op
below is sent with it. The Doc's last sections are this workstream's instructions, memories, links
and sessions. No Doc means the workstream does not exist yet (propose it to Durand; create it with
`add_workstream` only after he approves, then read the ID from the new Doc's title a minute later)
or the mirror has not run since it was added (wait a minute and search again). Never download the
Rulesets JSON for this: the Drive connector returns it base64-encoded and it is large.

## 2. Pick the workstream name (new workstreams only)

Title Case under the NAMING rule, short, distinct, matching how Durand refers to the work (e.g.
"FUB Build Monitor", "TSG Task Tracker"). Reuse an existing name exactly; never create a
near-duplicate. A workstream whose title changed is NOT a new workstream: find it by ID (or by its
old name) and use `rename_workstream`. Never send an `id` on `add_workstream`; the tracker assigns it.

## 3. Consolidate, then write ONE op per patch file

Instructions are ONE CURRENT SET, not a log: the full text of what this workstream owns, does and
must never do, as it stands now (merge everything learned into it; drop anything superseded).
`update_workstream_instructions` REPLACES the text, so send the whole consolidated set. Memories are
durable, load-bearing facts (corrections, standing decisions, structural gotchas) not already obvious
from the instructions; one `add_workstream_memory` patch per new memory, `remove_workstream_memory` by
index for one that is stale. Show Durand the exact text and get his approval before pushing.

Via the Drive connector's `create_file`: `contentMimeType` `"application/json"`,
`disableConversionToGoogleType` `true`, `parentId` `"1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi"` (the
tracker's `_Inbox`), filename `workstream-sync-<id>-<timestamp>.json`. One op per file. Serialize
with a real JSON encoder and parse the exact text before upload (an unescaped quote files the patch
as MALFORMED).

New workstream (after Durand approves; fails if the name exists; the tracker assigns the ID):

```json
{"target":"rulesets","op":"add_workstream","name":"<Workstream Name>","instructions":"<the consolidated set>","memories":["<fact 1>","<fact 2>"],"ts":"<ISO>"}
```

Replace the instructions (address the workstream by `id`; `name` still works, and when both are
sent they must agree):

```json
{"target":"rulesets","op":"update_workstream_instructions","id":"<T###>","instructions":"<the consolidated set>","ts":"<ISO>","historyEntry":{"summary":"<one line: what changed>"}}
```

Add one memory / remove one by index (0-based, from the Doc's memory list):

```json
{"target":"rulesets","op":"add_workstream_memory","id":"<T###>","memory":"<fact>","ts":"<ISO>"}
{"target":"rulesets","op":"remove_workstream_memory","id":"<T###>","index":0,"ts":"<ISO>"}
```

Mark a code workstream (its Doc then carries the Code layer under General):

```json
{"target":"rulesets","op":"set_workstream_code","id":"<T###>","code":true,"ts":"<ISO>"}
```

Record the Claude Project URL and repo (shown on the Settings card and in the Doc):

```json
{"target":"rulesets","op":"set_workstream_links","id":"<T###>","projectUrl":"https://claude.ai/project/...","repo":"tsg-homes/<Repo-Name>","ts":"<ISO>"}
```

Rename (the ID, memories, code, sessions, history and the same Doc all stay; only when Durand
renamed it or asks):

```json
{"target":"rulesets","op":"rename_workstream","id":"<T###>","newName":"<New Name>","ts":"<ISO>"}
```

The old names (`add_thread`, `update_thread_instructions`, `add_thread_memory`,
`remove_thread_memory`, `remove_thread`, `rename_thread`, `set_thread_code`) are still accepted as
aliases; write the workstream names.

Never send `set_category`, `append_category`, `replace_category_text` or `remove_category` from a
workstream: General and Code are Durand's (Settings > Rulesets, or a patch he asks for).

## 4. Confirm and stop

The 1-minute trigger applies the patch and rewrites the workstream's Doc. After a minute, search
the Doc by title again and confirm the new text is there; the patch file is trashed on success, a
failed one stays in `_Inbox` as `FAILED-`/`MALFORMED-` and is listed under Settings > General. Tell
Durand in one line what you pushed and give the Doc link on its own line.

## Rules

- Never write to the Rulesets or Data file directly; never curl or POST to the exec URL; never
  paste the exec URL or any token anywhere.
- One current set per workstream; the tracker keeps history, the workstream does not.
- Point the Claude Project's instructions at the workstream's Doc (one line, with the ID); never paste a copy.
- The ID is the workstream's identity: never create a second workstream because a title changed, never guess an ID, never send an ID on `add_workstream`.
- A workstream never edits General or Code.
