# Work Tracking

A personal record of the work done with Claude: what each piece of work is and where it stands.

## Language

**Worklog**:
The single, long-lived, running record of every Work Item. Entries are never removed; older entries recede from view but stay searchable.
_Avoid_: report, dashboard, snapshot

**Work Item**:
One coherent piece of work, pursued across one or more Sessions, with its own Status and State Phrase. The unit of one Worklog entry.
_Avoid_: task, ticket, job

**Worktree**:
An isolated working copy of a repository, managed by Orca, where Sessions run. Hosts a sequence of Work Items over time, at most one of them open at once.
_Avoid_: workspace (Orca's UI term for the same thing), checkout

**Closing**:
Ending a Work Item's scope by the user's choice, marking it finished so its Worktree can host a new Work Item.
_Avoid_: completing, archiving

**Drift**:
A prompt that pursues a different subject than the open Work Item it was sent in. Detecting Drift leads to an offer to start a new Work Item, never to a silent split.
_Avoid_: scope creep, topic change

**Session**:
One Claude Code conversation, identified by its session ID and recorded as one transcript.
_Avoid_: agent, chat, conversation

**Title**:
The human-readable name of a Work Item, derived from its branch name (including any ticket number) unless the user sets one explicitly.
_Avoid_: name, label, subject

**Status**:
The fixed-vocabulary condition of a Work Item, used for scanning and sorting.
_Avoid_: state (reserved for the State Phrase)

**State Phrase**:
A single phrase saying where a Work Item currently stands, in more detail than its Status.
_Avoid_: summary, description

**Status Override**:
A Status set explicitly by the user, which takes precedence over the inferred Status until the user clears it.
_Avoid_: manual status, forced status

**Pending Update**:
A note that a Work Item has changed and its Worklog entry needs refreshing. Recorded instantly when something happens; acted on later.
_Avoid_: dirty flag, queue item, event

**Keeper**:
The single long-running Session that periodically processes Pending Updates and publishes them to the Worklog.
_Avoid_: daemon, worker, sync job

**Archived Transcript**:
A local file copy of a finished Work Item's Session transcripts, referenced from its Worklog entry. The Worklog itself never contains transcript content.

## Relationships

- A **Worklog** contains many **Work Items**
- A **Work Item** spans one or more **Sessions**
- A **Worktree** hosts many **Work Items** in sequence, at most one open at a time
- A **Work Item** becomes finished either by evidence (merged PR, removed **Worktree**) or by **Closing**
- The user may override a **Work Item**'s inferred **Status** at any time; a **Status Override** holds against all evidence until the user clears or replaces it
- The user may delete a **Work Item** from the **Worklog**
- A **Work Item** has exactly one **Status** and one **State Phrase** at any time
- A finished **Work Item** has one or more **Archived Transcripts**
- Every **Session** belongs to exactly one **Work Item**; Drift and Closing both begin a new Session
- After **Closing**, the next **Work Item** in the same **Worktree** gets its own branch
- A deleted **Work Item** stays deleted; its **Archived Transcripts** remain on disk
- The **Keeper**, or the user on demand, turns **Pending Updates** into refreshed **Worklog** entries

## Flagged ambiguities

- "Agent session" was used for both the transcript-level unit and the piece of work — resolved: **Session** is the transcript, **Work Item** is the piece of work.
