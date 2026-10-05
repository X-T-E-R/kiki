# Spotlight: the task board — work you can point at

*A Kiki feature spotlight.*

Chat history is where work gets discussed, and it is a poor place for work to *live* — scroll back far enough and every decision dissolves into the transcript. Each workspace gets a **task board**: requirements tracked as cards that link to the sessions working on them.

![The workspace task board.](shots/r04-task-board.en.light.png)

## Tasks linked to sessions

Every card can link to the session working on it, so you can see not just *what* is pending but *who* is on it, and jump straight into that session to steer. The main agent reads and updates the board itself with `BoardRead` and `BoardWrite`, under the ordinary approval rules, so a card's status moves as the work does instead of going stale while the conversation scrolls past.

![A card detail view: the linked execution sessions are one click away from the task.](shots/board-task-detail.en.light.png)

## Cards outlast the session

A card is a standing requirement, not a line of chat. It stays on the board across days and across many sessions, so anyone opening the workspace later can see what was still outstanding — the part a transcript never gives you. Where the board lives is your call: reuse a compatible store already in the workspace, keep every workspace's boards under the Kiki home, or point at a fixed path. Cards keep pointing at the store they were created in if you change that setting later.

Combined with [goal mode](https://x-t-e-r.github.io/kiki/en/guides/goals) and cron-scheduled prompts, the board covers the third part of the loop: you decide the work and watch it, and when you come back later, what was outstanding is still written down. See the [task board guide](https://x-t-e-r.github.io/kiki/en/guides/sessions#task-board) for the full contract.
