# Parameters a video model accepts

## The set belongs to the model, and it moves

Duration, aspect ratio, and resolution are not one list across providers or
across models from the same vendor. A model released this month may not accept
the range its predecessor did, and a package may support only one model.

`media` → `capabilities` with a `provider` and `model` returns the current
answer, including the `output` limits and a `constraints` list. That answer is
the source. Model names, duration ranges, and resolution ladders recalled from
elsewhere are guesses, and a wrong guess is a rejected request or a silently
adjusted one.

When a package declares support for one model only, that is the whole set. A
newer model appearing on a vendor's site is not supported until the package
says so.

## Defaults are not requirements

Omitting `duration_seconds`, `aspect_ratio`, or `resolution` lets the provider
choose, and it reports what it chose in `effective` on the finished job. That
is usually the right move: it avoids a rejected request over a parameter the
user did not care about.

Specify a parameter when the user asked for it, or when the shot genuinely needs
it — a vertical phone clip, a fixed duration that has to match a narration
length. Otherwise leave it out and read `effective` afterwards.

## If a value is not accepted

An explicit request the provider cannot satisfy is reported rather than
adjusted. The host does not substitute the nearest size or drop a parameter
while still describing the result as what was asked for.

So when a request comes back with a `warnings` entry about a value that was
changed or ignored, that is the answer to report. "You asked for 4:3 at 2K;
this model produced 16:9 at 768P" is useful. Delivering the 16:9 and describing
it as 4:3 is not.

## Matching a narration length

When a shot has to match a voice line, generate the speech first, read its
`effective` duration, and then ask for a video of that length. This also means
the two files exist before the video job is submitted, so a mismatch is caught
before anything is charged for the video.
