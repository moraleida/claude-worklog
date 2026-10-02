# Worklog: design

Agreed in a grilling session on 2026-10-01. Vocabulary is defined in `CONTEXT.md`; the publishing architecture is recorded in `docs/adr/0001-keeper-publishes-from-artifact-database.md`.

## What it is

A user-scope Claude Code plugin named `worklog` (skill, slash command, hooks, Keeper prompt, artifact page). It maintains one long-lived, private **Worklog** artifact, for the user only. Entries are never removed automatically.

## Rows

- One row per **Work Item** = one branch in one directory: an Orca or git **Worktree**, a **Clone**, or (no branch) a folder outside git. A Worktree hosts many Work Items in sequence, at most one open at a time. Every **Session** belongs to exactly one Work Item. After **Closing**, the next Work Item in that Worktree gets its own new branch.
- Sources: local Claude Code sessions only (`~/.claude/projects`). Log everything, including small sessions.
- Columns: **Title** (from the branch name, ticket shown as a link; `/worklog title:` overrides), **Status** (`in progress · blocked · awaiting review · done · abandoned`), **State Phrase**, Last active, Sessions (count, expands to IDs), Where (live: Worktree name/path, copy-to-resume button, linked PR/issue; finished: Archived Transcript path).

## Layout

- "This week" open, "Last 30 days" collapsed, "All time" collapsed; a search box filters all tiers and opens matching sections.
- Rows can be deleted from the page: hidden permanently (tombstone); archives stay on disk; the Keeper never resurrects a deleted row.
- Only deletion is possible from the page; all other edits go through `/worklog`.

## Status

- Inferred from strong evidence only: a merged PR or a removed Worktree means `done`; an open PR means `awaiting review`; otherwise `in progress`; in a **Clone**, a deleted local branch also means `done`, unless its PR is open.
- A **Status Override** (`/worklog <status>`) holds against all evidence until `/worklog reset` or another override.

## Archive

When a Work Item finishes, each of its Sessions is saved to `~/worklog/transcripts/<date>-<branch-slug>/` as readable Markdown and raw JSONL. Subagent transcripts excluded. The Worklog never contains transcript text.

## Freshness

- Fast command hooks (`SessionEnd`, `PostCompact`, debounced `Stop`) only record **Pending Updates**.
- One **Keeper** Session (`/loop` in any terminal, about every 30 minutes) turns them into refreshed rows and publishes; `/worklog` does it immediately.
- Canonical rows live in the artifact database; local disk holds only Pending Updates, a small cache, config and archives.

## Drift

A non-blocking hook on every prompt checks it against the open Work Item. On a different subject, Claude offers `/worklog new` (new Work Item and Session, carrying the drifted prompt over) or `/worklog close` (finish current, new branch here), or continuing.

## Commands

| Command | Effect |
|---|---|
| `/worklog` | Update the Worklog now |
| `/worklog <status>` | Set a Status Override |
| `/worklog reset` | Clear the Status Override |
| `/worklog title: <text>` | Set the Title |
| `/worklog new [description]` | Start a new Work Item and Session: a new Orca Worktree when Orca is installed, otherwise a new branch in place |
| `/worklog close [done\|abandoned]` | Close the current Work Item, cut a new branch here |
| `/worklog backfill <window>` | Import older sessions (`90d`, `all`) |

`new` and `close` ask once for a ticket number and never block on it; branch names follow the user's rules (`feature/` or `fix/`, optional ticket segment).

## First run

Publishes the page and imports the last 30 days of sessions.
