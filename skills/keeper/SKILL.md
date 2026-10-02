---
name: keeper
description: One Keeper pass of the Worklog. Runs a /worklog Sync in a forked context so its tool output stays out of the Keeper Session. Scheduled by the Keeper Session, e.g. with cron `7,37 9-17 * * *` (every 30 minutes, 9am–6pm).
context: fork
---

Invoke the `worklog:worklog` skill with no arguments and follow its **Sync** steps exactly.

Return only its one-line result (how many Work Items were updated and archived, plus the Worklog link, or "Worklog is up to date"). Nothing else.
