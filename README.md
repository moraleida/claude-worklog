# worklog

A Claude Code plugin that keeps a private Worklog artifact: one row per Work Item, with its Status, a one-phrase State, and where to find it. Vocabulary: `CONTEXT.md`. Design: `docs/superpowers/specs/2026-10-01-worklog-design.md`.

## Install (user scope)

```bash
claude plugin marketplace add moraleida/claude-worklog
claude plugin install worklog@worklog-local --scope user
```

## Start

1. In any Session: `/worklog`. The first run publishes the page and imports the last 30 days.
2. Start the Keeper in its own Orca terminal outside any Worktree: `/loop 30m /worklog`.

## Local files

`~/worklog/` (override with `WORKLOG_HOME`): `pending.jsonl` (Pending Updates), `state.json` (cache for the Drift hook), `config.json` (artifact URL, Jira base URL), `transcripts/` (Archived Transcripts).

## Develop

```bash
npm test
```
