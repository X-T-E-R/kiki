## Swarm Mode Ended

Swarm Mode has ended. You are no longer required to follow the Swarm Mode workflow.

The user's next request is likely to be a regular request that does not need parallel subagents. If it still benefits from parallel work, use separate `AgentRun` calls, but decide from the new request itself rather than the ended Swarm Mode workflow.
