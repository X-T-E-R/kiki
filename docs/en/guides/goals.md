# Goals

Goals keep Kiki working toward a defined outcome across turns (a turn is one full pass of the agent handling one message). Unlike a normal prompt that says what to do next, a goal says what must become true. Use `/goal` to enter goal mode when the task has a clear finish line, but the next useful step depends on what the agent learns while it works — for example, fixing a batch of failing tests or tracking down the root cause of a broken build.

## Start a goal

Write the objective after `/goal`:

```sh
/goal Fix bugs listed in the issue tracker.
```

Kiki saves the objective, sends it as the next user message, and starts goal mode. After each turn, it checks the goal's four states: complete (done), blocked (cannot make progress), paused (interrupted by you or by an error), or still active.

Goals work best when the objective names the finish line and the evidence that proves it:

```sh
/goal Fix every bug labeled checkout-regression, add or update tests for each fix, and run the checkout test suite
```

Avoid goals that only name a broad direction:

```sh
/goal Find all bugs in this codebase.
```

That goal does not say what counts as success, what to inspect, or when to stop. The agent may block immediately, or keep working far longer than you expected.

### When to use goals

1. Use goals for work with a clear finish line and verifiable evidence.

    ```sh
    /goal Fix every failing checkout test and run the checkout test suite successfully.
    ```

    Kiki can inspect test output, change files, rerun checks, and decide when the goal is complete.

2. Use goals when the task may need several turns of investigation and repair.

    ```sh
    /goal Find why the release build fails, fix the root cause, and verify the build passes.
    ```

    The goal describes the result, so the agent can adapt when the first clue is not the root cause.

3. Use goals for ordered work that should continue without another prompt.

    ```sh
    /goal Update the feature implementation, add docs, run tests, and summarize the changed files.
    ```

    This is useful when you already know the checks or artifacts that must exist before the work is done.

### When not to use goals

1. Do not use goals for broad topics or open-ended discussions. `/goal Greetings!` is not a goal — the agent marks it complete immediately.

2. Do not use goals for tasks that are known to be impossible or unresolvable. If the agent judges a goal impossible, such as `/goal Prove 1 + 1 = 3.`, it marks the goal blocked and explains why.

3. Do not use goals with ambiguous or complicated objectives. A goal with unclear boundaries, like `/goal Create a videogame in a single HTML file.`, may complete — or may produce unexpected results after a long wait.

## Manage the lifecycle

Use the same command surface to inspect or control the current goal:

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Show the current goal and its progress |
| `/goal pause` | Pause the active goal without deleting it |
| `/goal resume` | Resume a paused or blocked goal |
| `/goal cancel` | Remove the current goal |
| `/goal replace <objective>` | Replace the current goal with a new objective |

A goal can stop in three ways:

- **complete**: the objective is done, Kiki clears the goal, and the agent summarizes how it completed the work
- **paused**: you paused it, interrupted the turn, resumed a session that had an active goal, or hit a model, provider, or runtime error
- **blocked**: Kiki needs input, cannot complete the goal as stated, or reached a budget limit. When the agent blocks a goal, it writes a short message explaining why.

Write stop conditions into the objective. `/goal` does not have a separate stop-limit flag.

## Manage goals in the web UI

The web UI shows the current goal in a strip below the conversation. Select the strip to expand or collapse its details. When a token budget (a cap on how many tokens the agent may spend on this goal) is configured, the header shows its progress; goals without a token budget do not show a progress bar.

Use the strip actions to pause an active goal, resume a paused or blocked goal, or cancel the current goal. Selecting Resume starts the next goal turn so the agent continues the work. Cancellation requires confirmation because it cannot be resumed afterwards.

## Queue upcoming goals

Agents sometimes complete a goal quickly while the next piece of work is already on your mind — previously you had to wait for the goal to finish, return to the TUI, and submit the next one manually. Use `/goal next` to queue upcoming goals without interrupting the current one:

```sh
/goal next Update the release notes after the tests pass
```

Upcoming goals are not visible to the agent while the current goal is running. When the current goal completes, Kiki starts the first upcoming goal in the same way as users enter `/goal <objective>`.

If no goal is active, `/goal next <objective>` starts that objective immediately. It behaves like `/goal <objective>` and shows a status message before the goal starts.

Manage upcoming goals interactively:

```sh
/goal next manage
```

In the manager, use <kbd>↑</kbd> / <kbd>↓</kbd> to browse, <kbd>Space</kbd> to select a goal for moving, <kbd>↑</kbd> / <kbd>↓</kbd> to reorder it, <kbd>E</kbd> to edit, <kbd>D</kbd> to delete, and <kbd>Esc</kbd> to cancel. When editing, use <kbd>Shift-Enter</kbd> or <kbd>Ctrl-J</kbd> to add a new line, and <kbd>Enter</kbd> to save.

If the current goal is paused, canceled, or blocked, Kiki does not start the next upcoming goal. When a goal blocks and upcoming goals exist, the TUI reminds you that they wait for completion.

## Use goal mode carefully

Goal mode is useful for work that can be checked with files, tests, command output, generated artifacts, or a clear written report. It is less useful for a one-off edit or a question that only needs one answer.

The permission mode decides whether tool calls need your approval. In `manual` mode, goal work may pause for tool call approval. For unattended work (no one present to approve or answer questions), use a permission mode that matches the risk of the repository and the commands the agent may run.

In non-interactive prompt mode (`kiki -p`, which runs one prompt and exits), only goal creation is supported:

```sh
kiki -p "/goal Fix the failing checkout test"
```

Prompt mode communicates the result through its exit code (the status number a program returns to the caller, used by scripts to branch): `0` when the goal completes, `3` when it blocks, and `6` when it pauses. `/goal next` and other management commands are TUI controls.
