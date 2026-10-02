# worklog

A Claude Code plugin that keeps a private Worklog artifact: one row per Work Item, with its Status, a one-phrase State, and where to find it. Vocabulary: `CONTEXT.md`. Design: `docs/superpowers/specs/2026-10-01-worklog-design.md`.

A Work Item is one branch in one directory. The plugin works in two setups:

- **With [Orca](https://onorca.dev) (recommended).** Each Work Item gets its own Orca Worktree, so several can run side by side, and `/worklog new` opens the next one in a new Worktree with its Session already started.
- **Without Orca.** Work in a plain git Clone and switch branches in place. Plain `git worktree`s are recognised too.

## Requirements

- Claude Code, signed in to claude.ai (the Worklog is a private claude.ai artifact).
- Node.js 24 or later.
- `git`.
- Optional: the GitHub CLI `gh`, signed in. Without it, PR state is unknown, so no Work Item moves to `awaiting review` or `done` on PR evidence.

## Install

```bash
claude plugin marketplace add moraleida/claude-worklog
claude plugin install worklog@worklog-local --scope user
```

Then, in any Session, run `/worklog`. The first run publishes the Worklog page, imports the last 30 days of Sessions, and prints the page's link.

### With Orca (recommended)

1. Install Orca from [onorca.dev](https://onorca.dev) and add your repositories to it.
2. Check that the `orca` command answers in a terminal: `orca status`. The plugin uses it to name Worktrees on the page and to create new ones.
3. Open an Orca terminal outside any Worktree (for example in `~`), start `claude`, and run the Keeper:

   ```
   /loop 30m /worklog
   ```

### Without Orca

1. Nothing else to install. Work in a Clone of your repository as usual.
2. Open a terminal outside any Clone (for example in `~`), start `claude`, and run the Keeper:

   ```
   /loop 30m /worklog
   ```

## Use

The Keeper refreshes the Worklog about every 30 minutes. Everything else is a `/worklog` command in the Session you're working in:

| Command | Effect |
|---|---|
| `/worklog` | Update the Worklog now |
| `/worklog <status>` | Set a Status Override: `in progress`, `blocked`, `awaiting review`, `done` or `abandoned` |
| `/worklog reset` | Clear the Status Override |
| `/worklog title: <text>` | Set the Title |
| `/worklog new [description]` | Start a new Work Item (see below) |
| `/worklog close [done\|abandoned]` | Finish the current Work Item and start a new branch here |
| `/worklog backfill <window>` | Import older Sessions, e.g. `90d` or `all` |

`new` and `close` ask once for a ticket number. You can skip it.

When a prompt looks like a different subject from the open Work Item, Claude offers `/worklog new`, `/worklog close`, or continuing where you are.

### With Orca

- **`/worklog new`** creates a new Orca Worktree on a new branch and starts a Session there with your prompt. The current Work Item stays open in its own Worktree.
- **`/worklog close`** marks the current Work Item finished and cuts the next branch in the same Worktree. Run `/clear` afterwards to start the next Session.
- **Status** becomes `done` when the PR is merged or the Worktree is removed, and `awaiting review` while the PR is open.
- **Copy resume** on the page reopens the Session in its Worktree.

### Without Orca

- **`/worklog new`** (in a Clone) needs a clean working tree. It creates the new branch from the default branch in place, then asks you to `/clear` and send the prompt it shows you. The previous Work Item stays open on its own branch.
- **`/worklog close`** works the same as with Orca.
- **Status** becomes `done` when the PR is merged or the local branch is deleted, unless the PR is still open. It's `awaiting review` while the PR is open.
- **Copy resume** on the page switches back to the Work Item's branch, then reopens its Session.
- **In a plain `git worktree`**, a Worktree holds one open Work Item at a time. `/worklog new` therefore offers `/worklog close` instead, or a Worktree you create yourself.
- **In a folder outside git**, all its Sessions form one Work Item. `/worklog done` marks it finished.

## The Worklog page

Work Items are grouped into "This week", "Last 30 days" and "All time". Search across Titles, branches, tickets and Session IDs, or filter by Status, repository and last-active dates. Deleting a row from the page hides it for good; its Archived Transcripts stay on disk.

## Local files

`~/worklog/` (override with `WORKLOG_HOME`): `pending.jsonl` (Pending Updates), `state.json` (cache for the Drift hook), `config.json` (artifact URL, Jira base URL), `transcripts/` (Archived Transcripts).

## Develop

```bash
npm test
```
