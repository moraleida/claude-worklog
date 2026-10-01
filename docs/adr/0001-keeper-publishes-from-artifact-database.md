# A Keeper session publishes the Worklog; hooks only record Pending Updates

Hooks cannot publish the Worklog themselves: `SessionEnd` hooks share a 1.5-second budget and run after the model can take no more turns, and the Artifact tool is only available to interactive sessions, not headless `claude -p`. So hooks only record Pending Updates locally, and a single long-running Keeper session (a `/loop` in Orca), or `/worklog` on demand, turns them into refreshed entries. Worklog rows live in the artifact's own database rather than a local file, because the user can delete rows from the page and those deletions must be durable and visible to the Keeper.

## Considered Options

- **Each session publishes its own row from a `Stop` agent-hook**: always current, but costs model time on every turn of every session, and it is unverified whether agent hooks can use the Artifact tool.
- **The next session to start publishes pending items from a `SessionStart` hook**: needs no Keeper, but adds a delay to the start of unrelated work.

## Consequences

If the Keeper is not running, the Worklog goes stale until someone runs `/worklog`; Pending Updates are never lost, only delayed.
