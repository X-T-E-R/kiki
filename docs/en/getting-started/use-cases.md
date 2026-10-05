# Common use cases

Each section below is a situation you will actually hit, with prompts you can send as they are. Adapt the wording to your project.

## Understanding an unfamiliar project

Plan mode (the agent writes out what it intends to do and waits for your go-ahead before touching files) is worth turning on before you ask for changes in code you have not read yet. Start the CLI with `--plan`, press `Shift-Tab`, or type `/plan` in a session:

```text
Give me an overview of this repository's architecture. Specifically:
1. Where is the entry point and what happens at startup?
2. How do the main modules depend on each other?
3. How are configuration and data loaded?
Finally, draw a simple module dependency diagram.
```

You can also focus on a specific question:

```text
How does the event loop in src/runtime work? Where do events originate, and what consumes them?
```

```text
How is "permission approval" implemented in this project? Which files are involved, and what are the key types?
```

For a large investigation, ask the main agent (the one you are talking to) to split the work across sub-agents, which work in parallel on pieces of it. [Agents and sub-agents](../customization/agents.md) covers how to prompt for that.

## Implementing a new feature

State the requirement and what "done" looks like. For a change that touches several files, confirm the approach in Plan mode before it runs:

```text
Add a retry utility under src/utils:
- Signature: retry<T>(fn: () => Promise<T>, options): Promise<T>
- Options: maxAttempts, initialDelayMs, backoffFactor
- On failure, throw the error from the last attempt
- Add a unit test suite covering: success on first try, success after retries, and all attempts failing
```

If the result isn't right, just describe what you want changed — no need to edit manually:

```text
The backoff calculation used a fixed value. I'd like to add some jitter to avoid the thundering-herd effect. Update the implementation and the tests.
```

## Fixing a bug

Give the symptom, how to reproduce it, and what you expected — all in one message, so the agent does not have to ask you back:

```text
Running npm test occasionally produces this error:

  TypeError: Cannot read properties of undefined (reading 'id')
      at SessionStore.update (src/session/store.ts:142:18)

It only appears in test cases that concurrently trigger multiple updates. Please locate the cause and fix it, then run the full test suite to confirm.
```

When you do not know the cause yet, ask for investigation before any edits:

```text
User feedback: after a successful login, the first page refresh sends you back to the login page; a second refresh works fine. Please find the most likely causes first and list the most suspicious locations. I'll confirm the direction before you start making changes.
```

When the fix is mechanical, you can hand it over as-is:

```text
Run the test suite, fix every failing test case, then run it again to confirm everything is green.
```

## Writing tests and refactoring

Work with a clear boundary and a checkable result is the easiest kind to hand over:

```text
src/parser/markdown.ts currently has almost no tests. Please add a unit test suite covering: normal paragraphs, nested lists, code blocks, tables, blockquotes, and mixed content. Follow the testing style already used in the project.
```

```text
Extract the repeated "read body → validate → log → respond" pattern in src/handlers into a middleware. Run the tests afterwards to make sure existing behavior is unchanged.
```

For a refactor that spans several files, confirm the approach in Plan mode first. Another option is to `/fork` the session, try the refactor in the copy, and switch between them from `/sessions` — the original session keeps running either way.

## One-off scripts and automation

Batch file edits, statistics, and research comparisons each fit in a single prompt:

```text
Change all var declarations in .js files under src to const or let, preferring const where possible. Run lint once you're done to confirm.
```

```text
Analyze the access logs in logs/ from the past 7 days. For each API path, compute the call count, p50, and p99 response times, and output the results as a Markdown table.
```

```text
Research the main dependency injection options for TypeScript (tsyringe, inversify, awilix). Compare them across three dimensions: API style, decorator requirements, and runtime overhead. Give me a recommendation that fits on one page.
```

For a batch of work you already trust, you can stop approving each call. Start the CLI with `--yolo` or type `/yolo` in a session — both switch the session to YOLO mode, where tool calls including reads of sensitive files run without asking, unless a permission rule denies them. Exiting Plan mode is still reviewed. For a narrower option, pre-approve specific tools in the `[permission]` section of [Configuration files](../configuration/config-files.md#permission).

## Scheduled tasks and reminders

In an interactive session, ask the agent for a one-time reminder or a recurring task. It writes a cron expression (the standard way to express "when to run") in your local timezone and re-sends the prompt into the same session each time it fires:

```text
Remind me at 2:30 PM to check the deployment.
```

```text
Every weekday at 9 AM, summarize recent CI failures for me.
```

```text
Check the production health endpoint every hour and let me know if anything looks wrong.
```

```text
Come back in about 10 minutes and check whether the build has finished.
```

A schedule belongs to the session that created it. Closing the terminal is fine — resume that same session with `kiki --session` and the schedule reloads and keeps firing. A brand-new session starts with no schedules. Recurring schedules stop after 7 days; on the last run the agent is told the schedule has expired and renews it only if your original instructions asked for that.

To see what is pending, just ask — the agent reads the schedule list. To cancel one, tell the agent to remove it or give its 8-character ID. [Scheduled tasks](../reference/tools.md#scheduled-tasks) documents the tool, and `KIKI_DISABLE_CRON=1` turns scheduled tasks off entirely.

## Generating and maintaining documentation

```text
I just changed the interface signature in src/auth/login.ts. Please update the corresponding JSDoc, the example code in README, and any paragraphs in docs/en/guides that mention this interface.
```

```text
For every public function under src/api that is missing a docstring, add a documentation comment following the style of the existing ones.
```

```text
Based on the command implementations in src/cli, generate a draft command reference listing each subcommand, its arguments, and default values. Put it in docs/en/reference for me to review later.
```

To keep a record or do a retrospective, `kiki export <sessionId>` packages a session as a ZIP; `/export-md` inside the TUI writes a readable Markdown transcript.

## Next steps

- [Agents and sub-agents](../customization/agents.md) — how to have the agent dispatch sub-tasks for parallel execution
- [Hooks](../customization/hooks.md) — trigger local scripts at task-completion and other lifecycle points
- [Built-in tools](../reference/tools.md) — full reference of all tools the agent can call
