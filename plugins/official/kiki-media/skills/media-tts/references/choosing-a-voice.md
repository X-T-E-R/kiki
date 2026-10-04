# Choosing a voice

## Get the list, do not recall it

`media` → `voices` with a `provider` returns that provider's voices. It is the
only place the ids come from. A voice id from another provider is not a voice
id here, and a plausible-looking id is a rejected request rather than a default.

Add `language` to narrow the list. Leave it off when you want to see everything
a provider has — some voices carry no language tag at all, and filtering on
language alone hides them.

The list is paged. Ask for the next page when the user is genuinely browsing;
do not page through everything to build a comparison you were not asked for.

## What a voice entry tells you

An entry carries an id, usually a label, and sometimes language tags. That is
all. It does not tell you how the voice sounds, how it handles numbers or
abbreviations, or how it reads a particular script.

So the honest way to choose is: narrow by language, offer a few named options
with what is actually known about them, and let the user listen. A short sample
of their own text is usually the fastest way to settle it — and it is a small
call.

## A language tag is a hint

A voice tagged `zh` is one the provider associates with Chinese. It is not a
guarantee that it reads Chinese well, and it says nothing about a voice tagged
`en` handling a line with Chinese in it. When a request mixes languages, that
is worth saying out loud rather than discovering from the audio.

## When several providers are installed

Each provider has its own voice list, and they are not interchangeable. If the
user has no default for speech, ask which one to use rather than picking one —
a voice call is a bill, and a second provider reached by accident is a second
bill.

Once the user has chosen a provider for speech in settings, later requests go
there without asking again.

## Voice design and cloning are not this

Creating a new voice, cloning one, or training anything is a different
operation from speaking text, and it is not part of `generate`. If the user asks
for a cloned voice, say that the text-to-speech path does not do it and leave
the decision about what does to them.
