---
title: Phone session
---

# Phone session

A phone session lets one paired chat talk with a persona's daily conversation, or with a session you pick. Open **Settings → Notifications & messages**. The phone session sits between the notification rules and the one-way channels.

Paste a setup and check it, or scan a WeChat code from this page. WeChat does not ask for a token or a numeric id here. Check an existing connection again without pasting the setup. Then send one message from the phone. Kiki shows who wrote, the chat, and a short preview. Bind that sender to a persona's daily session or to an existing session. A chat id inside the paste is not a binding. While that connection is listening, a new phone message shows up on this page.

A bound row can move to another session, turn phone actions on or off, and follow the default for new bindings again. While a turn is busy, the next phone message can wait in the queue or steer into the current turn. The phone can show the full visible text when the turn settles, or the text already written. Several questions stay together until each one has an answer. Approvals and questions can be answered from the phone. A sign-in that asks for a password stays on the desktop SSH screen.

QQ and WeChat send the full text and cannot change a sent message. They do not show buttons; the phone gets numbered choices instead. QQ cannot take a file. When QQ rejects a message as too long, the phone gets one sentence and the full text stays in the desktop session. When WeChat rejects a message as too long, the full text goes out as one file. A voice the platform cannot send as voice is sent as the original file, and that difference is counted on its own.

One-way notification channels are unchanged. If the bot already has a webhook, the page says so and leaves the webhook in place.

## What stays on this computer

The token is stored with the existing notification credential. It is not written into the conversation or the diagnostic log. A message from someone you have not bound is counted and does not start a turn.
