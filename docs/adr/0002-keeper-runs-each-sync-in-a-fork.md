# The Keeper runs each Sync in a forked skill on a working-hours schedule

The Keeper was `/loop 30m /worklog`. Every Sync's tool output (row listings, drafts, batch writes) stayed in the Keeper Session, so its context window filled with output nothing needed again. Running `/compact` after each Sync isn't possible: `/loop` and scheduled tasks can't run built-in commands, hooks can't start compaction, and the model has no tool that does. So the Keeper schedules the `keeper` skill (`/worklog:keeper`) instead. That skill has `context: fork`: it runs the Sync in an isolated context and returns only the one-line result to the Keeper Session. The schedule is cron `7,37 9-17 * * *`, every 30 minutes from 9am to 6pm, off the :00 and :30 marks.

## Considered Options

- **`/loop 30m /worklog` plus a lower auto-compact threshold** (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`): compacts earlier, but the output still lands in context and the Session keeps compacting.
- **A `Stop` hook that compacts after a Sync**: not possible, because hooks can't start compaction.

## Consequences

Scheduled tasks live only in the Session that created them, and a recurring task expires after 7 days. The user recreates the task weekly or after restarting the Keeper. Between 6pm and 9am the Worklog goes stale until the next pass or a manual `/worklog`; Pending Updates are never lost, only delayed.
