---
name: worklog
description: Keeps the user's private Worklog artifact up to date — one row per Work Item with its Status, State Phrase and where it lives. Use for /worklog and its arguments (a status, reset, title:, new, close, backfill), when the Keeper loop fires, or when the user asks to log, close, or split off work.
---

# Worklog

Vocabulary is fixed: Worklog, Work Item, Worktree, Clone, Session, Title, Status, State Phrase, Status Override, Pending Update, Keeper, Archived Transcript, Closing, Drift. Use these words with the user.

`CLI` below means `node "<this skill's base directory>/../../bin/worklog.mjs"`. `$S` means this session's scratchpad directory. Load `ArtifactData` with ToolSearch before its first use.

## Route the arguments

| Arguments | Do |
|---|---|
| none | **Sync** |
| a Status (`in progress`, `blocked`, `awaiting review`, `done`, `abandoned`; hyphens allowed) | **Override** with `{"statusOverride":"<status>"}` |
| `reset` | **Override** with `{"statusOverride":null}` |
| `title: <text>` | **Override** with `{"titleOverride":"<text>"}` |
| `new [description]` | **New** |
| `close [done\|abandoned]` | **Close** |
| `backfill <window>` | **Sync**, with `collect --since <window>` in step 3 |
| anything else | Show this table in one line and stop |

## Sync

1. Run `CLI config`. If there is no `artifactUrl`, do **First run** and stop.
2. `ArtifactData` `list` collection `workItems` on `artifactUrl`, paging until done. Write `$S/rows.json` as a JSON array whose elements are `{ "id": <doc_id>, "version": <version>, ...fields }` for each document.
3. Run `CLI collect --pending --recheck $S/rows.json > $S/drafts.json`.
4. If `drafts` is empty or none has `changed: true`, run `CLI ack --drafts $S/drafts.json`, say "Worklog is up to date", and stop.
5. For every draft with `changed: true` whose row isn't `deleted`, write one **State Phrase** from its `digest` plus `inferredStatus` and `prUrl`. Rules: at most 15 words; says where the work stands now, not what was said; no quotes from the transcript; no secrets, credentials, or client details beyond what the Title already shows. Write `$S/phrases.json` as `{ "<id>": "<phrase>" }`.
6. Run `CLI merge --drafts $S/drafts.json --rows $S/rows.json --phrases $S/phrases.json > $S/writes.json`.
7. `ArtifactData` `batch` on `artifactUrl`: one entry per item in `writes`: `{op:"set", collection:"workItems", doc_id: docId, data, if_version: ifVersion}`, omitting `if_version` when `ifVersion` is null. Send at most 50 per batch. If a batch fails on a version conflict, `get` the document it names. If it is now `deleted: true`, drop its write. Otherwise update its `version` in `$S/rows.json`, re-run merge (step 6) for the remaining writes, and retry once.
8. Run `CLI ack --drafts $S/drafts.json` only after every write has succeeded or been dropped as deleted. If a batch fails, don't ack; the Pending Updates stay claimed and the next Sync retries them.
9. Reply in one line: how many Work Items were updated and archived, plus the Worklog link. If merge returned `archiveErrors`, name those Work Items and the message; their next Sync retries.

## Override

1. Run `CLI current` to get `id`, `cwd`, `branch`.
2. Follow **Sync** steps 1–2. Then run `CLI collect --cwd <cwd> > $S/drafts.json` and write a fresh phrase only for `id`.
3. Write `{"<id>": <override>}` to `$S/override.json` with the Write tool, then run `CLI merge --drafts $S/drafts.json --rows $S/rows.json --phrases $S/phrases.json --override-file $S/override.json > $S/writes.json`. Never put user text inside a shell string. Then do **Sync** step 7. No ack is needed: `--cwd` claims nothing.
4. If `writes` contains the current `id`, confirm in one line, e.g. "Status Override set: blocked. `/worklog reset` returns to the inferred Status." Otherwise say no Work Item matched this directory and suggest running from the Worktree or Clone root.

## New

1. Description: use the argument, or the prompt that triggered the Drift offer, word for word.
2. Ask once: "Ticket number for this?" Accept an answer or a skip, and never ask again.
3. Branch name: `feature/` for new behaviour, `fix/` for correcting existing behaviour. Add `<TICKET>/` if a ticket was given, then a short lowercase hyphenated description of the change. Never a username, never a placeholder.
4. Write the description to `$S/prompt.txt` with the Write tool. Run `CLI current`, then:
   - `orca` is true: do **New in Orca**.
   - `checkout.kind` is `clone` or `worktree`: do **New in place**.
   - `checkout.kind` is `folder`: say this folder isn't a git repository, so its Sessions all belong to one Work Item; offer `git init` or continuing here, and stop.

### New in Orca

1. Run `orca worktree create --name <branch> --agent claude --prompt "$(cat "$S/prompt.txt")" --activate --json`. `<branch>` is safe to put in the command because **New** step 3 limits it to lowercase letters, digits, hyphens, slashes and the ticket ID. If `claude` isn't an accepted agent id, read `orca agent-context --json` for the right one.
2. Read the new worktree's `branch` from the JSON (or `orca worktree show --worktree name:<branch> --json`). If it isn't `<branch>`, run `git -C <path> branch -m <branch>`.
3. Tell the user in one line that the new Session is running in that Worktree, and continue the current Work Item here.

### New in place

1. If `git status --porcelain` shows uncommitted changes, stop and ask the user to commit or stash them first.
2. Find the base with `git symbolic-ref --short refs/remotes/origin/HEAD` (fall back to `origin/main`), then run `git fetch origin` and `git switch -c <branch> <base>`. With no `origin` remote, skip the fetch and use the current branch as the base.
3. Tell the user: the previous Work Item stays open on its branch, and its Copy resume button on the Worklog switches back to it. Then: "Run `/clear` and send this to start the new Session:" followed by the contents of `$S/prompt.txt` in a fenced block.

## Close

1. Run `CLI current`. If `checkout.kind` is `folder`, stop: this folder isn't a git repository, so it holds one Work Item and there is no branch to cut. Suggest `/worklog done` instead, and say that later Sessions here keep adding to that Work Item.
2. Status = the argument (`done` or `abandoned`), default `done`.
3. If `git status --porcelain` shows uncommitted changes, stop and ask the user to commit or stash them first.
4. Do **Override** with `{"statusOverride":"<status>"}`. Merge archives the Work Item.
5. Ask what the next Work Item here is, and its ticket (once, skippable). Build the branch name as in **New** step 3.
6. Find the base with `git symbolic-ref --short refs/remotes/origin/HEAD` (fall back to `origin/main`), then run `git fetch origin` and `git switch -c <branch> <base>`. With no `origin` remote, skip the fetch and use the current branch as the base.
7. Tell the user: "Closed <Title>. Run `/clear` to start the next Session on `<branch>`."

## First run

1. Read `page/index.html` and `page/view-model.js` (plugin root = this skill's base directory + `/../..`).
2. Publish with the `Artifact` tool: `file_path` = `page/index.html`, `files` = `{"view-model.js": "<root>/page/view-model.js"}`, `capabilities` = `{"db": {}, "user": {}}`, `icon` = `list`, `description` = "Every Work Item done with Claude, where it stands, and where to find it."
3. Run `CLI config --set artifactUrl=<url>`.
4. If the Atlassian connector is available, call `getAccessibleAtlassianResources` and run `CLI config --set jiraBaseUrl=<site url>` for the user's site. Skip this if the connector isn't available.
5. Do **Sync** with `collect --since 30d` in step 3.
6. Tell the user the link, and suggest starting the Keeper (below).

## Keeper

The Keeper is one long-running Session in its own terminal (an Orca terminal if you use Orca), outside any Worktree or Clone (for example in `~`), running:

```
/loop 30m /worklog
```

Each pass is a **Sync**. `/worklog` in any Session does the same thing immediately.
