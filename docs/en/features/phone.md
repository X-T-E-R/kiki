---
title: Phone session
---

# Phone session

A phone session lets one paired chat talk with a persona's daily conversation, or with a session you pick. Open **Settings → Notifications & messages**, where **Two-way chat**, **Push channels**, and **System alerts** are organized into separate tabs with **Two-way chat** open by default.

Paste a setup and check it, or scan a WeChat code from this page. WeChat does not ask for a token or a numeric id here. Once an account is connected, open **Bind persona or thread**, pick a persona or an existing thread, start listening, and send one message from your phone. Kiki shows who wrote, the chat, and a short preview so you can confirm the binding without re-scanning a code or pasting the setup again. A chat id inside the paste is not a binding. While that connection is listening, a new phone message shows up on this page.

A bound row can switch to another persona or session, and its options drawer lets you adjust busy behavior, phone text mode, phone actions, or follow the default for new bindings again. While a turn is busy, the next phone message can wait in the queue or steer into the current turn. The phone can show the full visible text when the turn settles, or the text already written. Several questions stay together until each one has an answer. Approvals and questions can be answered from the phone, including after Kiki restarts, as long as they are still open. On QQ and WeChat, each number answers the next open question, and words that are not one of the choices stay with that question. A sign-in that asks for a password stays on the desktop SSH screen. If Kiki restarts before the phone has the whole visible text, the rest of that text still arrives. The turn is not started again.

QQ and WeChat send the full text and cannot change a sent message. They do not show buttons; the phone gets numbered choices instead. QQ cannot take a file, and it has no fixed length cap. Only after the platform rejects a message as too long does the unsent text go out in successive pieces. Pieces already accepted stay on the phone, and the rest follows on the next try. Joined together they are the original text. A piece that did not go out is not treated as delivered. A single character that is still rejected produces one explanation on the phone, is not treated as delivered, and is not replaced by an attachment. When WeChat rejects a message as too long, the full text goes out as one file. A voice the platform cannot send as voice is sent as the original file, and that difference is counted on its own.

One-way notification channels are unchanged. If the bot already has a webhook, the page says so and leaves the webhook in place.

## What stays on this computer

The token is stored with the existing notification credential. It is not written into the conversation or the diagnostic log. A message from someone you have not bound is counted and does not start a turn.
