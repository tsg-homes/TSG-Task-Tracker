---
name: tsg-session-start
description: Start-of-session steps for every TSG Claude session. Read the General rules Doc, find and read the workstream Doc, record the session in the Task Tracker, and name the session.
---

# TSG Session Start (2026-09-23)

Source of truth for this skill is `skills/tsg-session-start/SKILL.md` in the
`tsg-homes/TSG-Task-Tracker` repo; Durand saves it to his account from Cowork.

Run these steps in order before any real work. Durand's current message always wins; if he says to
skip a step, skip it.

## 1. Read the General Doc

Read the Google Doc "Systems — Instructions — General"
(https://docs.google.com/document/d/1G-QI_F04Ye5SdEIJeOFq_Ex6da1v9oFDED49Ee-1HZM/edit, file id
`1G-QI_F04Ye5SdEIJeOFq_Ex6da1v9oFDED49Ee-1HZM`) with the Google Drive connector
(`read_file_content`). It holds all of TSG's current rules and binds the session. Claude Code
sessions also read "Systems — Instructions — Code" (search Drive by that exact title; it is in the
tracker folder's `Instructions` subfolder). If the Doc cannot be read, say so in the first line of
the reply, work only from the core rules in the Instructions for Claude box, and ask Durand before
anything consequential.

## 2. Find the workstream

A workstream is an ongoing body of work with a permanent ID (`T###`) and its own mirror Doc.

1. If the Claude Project's instructions (or the repo's CLAUDE.md) name a workstream ID, use it.
2. Otherwise match the request against the workstream names. List them from Drive: search titles
   containing `Systems — Instructions — Workstream — ` (each title ends `— <id> — <name>`). Do not
   download the Rulesets JSON for this.
3. If exactly one workstream clearly fits, use it. If more than one could fit, or none does, ask
   Durand with AskUserQuestion (name the candidates by name). Never guess.
4. One-off work that belongs to no workstream needs none; go to step 5 and skip steps 3-4.

## 3. Read the workstream's Doc

Read `Systems — Instructions — Workstream — <id> — <name>`. It repeats General (and Code for a code
workstream), then adds the workstream's own instructions, critical memories, links and latest
sessions. It adds to General and overrides it only where it says so.

## 4. Record the session

Push one `record_session` patch to the tracker `_Inbox` (Drive connector `create_file`, `parentId`
`1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi`, `contentMimeType` `application/json`,
`disableConversionToGoogleType` true, filename `session-<id>-<timestamp>.json`, one op per file,
serialized with a real JSON encoder):

```json
{"target":"rulesets","op":"record_session","id":"<T###>","sessionId":"<session id>","surface":"code-cloud","title":"<session title>","startedAt":"<ISO>","ts":"<ISO>"}
```

- `sessionId`: the session's ID only (e.g. `session_01...` or `cse_...`), never a link; links stop
  working once a session is deleted. Where a tool reports the current session (for example
  `get_session` with no `session_id` in a cloud Claude Code session), take it from there. If the ID
  cannot be found, say so and skip this step; never invent one.
- `surface`: `chat`, `cowork`, `code-local`, `code-cloud`, `scheduled` or `routine`.
- Push it again with the same `sessionId` when the title changes; the tracker updates the entry.

## 5. Name the session

Name the session under the General rules' NAMING rule (Title Case, under 60 characters, after the
system or project and what the session is doing to it, not after the first message). Use the
`set_session_title` tool with session id `self` where it exists; otherwise propose the title in chat.

## 6. Catch-up for a session that was never recorded

If this session has earlier history (it started before 2026-09-23, or before it was recorded) and it established durable rules, decisions or facts, list every one that is not already in the workstream's Doc. Show Durand the exact text, push nothing until he approves, then push them with tsg-workstream-sync. A session that started before the Instructions for Claude box changed on 2026-09-23 is still running the old box text: step 1 replaces it, so do step 1 first.

## 7. Work that fits no workstream

If the work is ongoing (it will span more than this session) and fits no workstream, propose a new
one to Durand: a Title Case name and a one-paragraph instruction set. Create it with `add_workstream`
(tsg-workstream-sync, step 3) ONLY after he approves, then read the new ID from the Doc title a minute
later and do steps 3-4 with it.

## Rules

- Never write to the Rulesets or Data file directly; never use the exec URL.
- A workstream never edits General or Code.
- Refer to workstreams by name, not ID, in anything Durand reads.
