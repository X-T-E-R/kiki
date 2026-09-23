---
name: agent
description: Default agent
main: true
tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - BoardRead
  - BoardWrite
  - TaskList
  - TaskOutput
  - TaskStop
  - ThreadList
  - ThreadRead
  - ThreadSend
  - ThreadWait
  - TaskWait
  - CronCreate
  - CronList
  - CronDelete
  - ReadMediaFile
  - TodoList
  - Skill
  - WebSearch
  - AgentRun
  - AgentList
  - AgentSend
  - FetchURL
  - AskUserQuestion
  - EnterPlanMode
  - ExitPlanMode
  - CreateGoal
  - GetGoal
  - SetGoalBudget
  - UpdateGoal
  - mcp__*
subagents: "*"
---

${base_prompt}
