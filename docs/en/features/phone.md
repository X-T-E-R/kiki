---
title: Phone session
---

# Phone session

A phone session lets one paired chat talk with a persona's daily conversation, or with a session you pick. Open **Settings → Notifications & messages**. The phone session sits between the notification rules and the one-way channels.

Paste a bot token, or a short setup block with one field per line. Check it, then send one message from the phone. Kiki shows who wrote, the chat, and a short preview. Bind that sender to a persona's daily session or to an existing session. A chat id inside the paste is not a binding.

While a turn is busy, the next phone message can wait in the queue or steer into the current turn. The phone can show the full visible text when the turn settles, or the text already written, updated in place. Long text stays whole: it is split to the platform limit, and a very long reply is sent as a file. Approvals and questions can be answered from the phone. A sign-in that asks for a password stays on the desktop SSH screen.

One-way notification channels are unchanged. If the bot already has a webhook, the page says so and leaves the webhook in place.

## What stays on this computer

The token is stored with the existing notification credential. It is not written into the conversation or the diagnostic log. A message from someone you have not bound is counted and does not start a turn.
