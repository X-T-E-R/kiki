# Variations of one idea

`count` asks the provider for several images **in one request**. It is not a
queue, and it is not a loop you should write around it.

## Use `count` when the user wants options

"Give me four covers for this" is one call with `count: 4`. The provider bills
and schedules it as one job, and the results arrive together.

## Do not loop for a batch

Calling `generate` N times to get N images is N submissions. Each one is a
separate request to the provider, each can be charged separately, and a failure
in the middle leaves the user with a partial set and no way to tell which call
produced which file. If a user asks for a large batch, either use `count` within
what the provider accepts, or say plainly that this is N requests and let them
decide.

## `request_id` is the idempotency key

Give a `request_id` when a request is worth repeating — a network retry, a
reopened conversation, a user who says "try that again". The same id with the
same request returns the same job instead of a second bill. The same id with a
*different* request is a conflict, not a new job: fix the id rather than
retrying into a second charge.

A `request_id` also makes the result addressable later, which matters when the
user comes back after the conversation has moved on.

## Comparing and choosing

When several come back, show the user what is actually different rather than
ranking them yourself. `effective` records the parameters each one used, so two
images that look similar but were generated at different sizes are visible as a
difference rather than a surprise.

If the user picks one, the others are still files. Do not delete them; say which
one you are continuing from.
