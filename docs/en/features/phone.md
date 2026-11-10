---
title: Phone session
---

# Phone session

Connect an IM account and bind each of its channels to a persona's daily conversation or a thread you pick. Different contacts, chats or supported group topics can use different targets under the same account. Open **Settings → Notifications & messages → Channels & accounts** (`/settings/notifications?tab=accounts`) to manage chat accounts and their channels.

Chat accounts and one-way push channels share the **My channels** card. Choose **Add channel**, then pick a platform in the side panel: WeChat connects by scanning a code with your phone and does not ask for a token or a numeric id; QQ offers the **Official QQ bot** (connected through the QQ plugin; install it, then scan here) or **Personal QQ (OneBot)** (run OneBot locally and sign in to your QQ); other platforms ask for their credentials, or you can paste a setup under **Paste / other**. When one platform can both talk and deliver alerts, the panel first asks which: **Talk with Kiki** or **Alerts only**.

Once an account is connected, turn on listening in its row and send a message from the contact, group or topic you want to add. Before any conversation exists, you can preselect a target under **Bind new conversations to**. A new message appears as an **A message arrived** card with the sender, channel and a short preview. Choose a **Persona** or **Thread** for it (for a persona you can tick **Also set as the daily session**), then **Bind**, or **Dismiss** it. Each discovery has its own target. Adding another channel needs no new scan or setup paste, and a chat id inside the paste is not a binding. The current WeChat connection supports direct messages only: contacts can have separate bindings, while group discoveries remain visible but cannot be bound.

While listening is on, Kiki automatically reconnects a dropped or stalled Feishu, Telegram or WeChat connection; ordinary chat silence does not trigger a reconnect. A reconnecting account shows the reported failure when available; expand it for numeric details. If authorization expires, choose **Authorize again** for that account. If its connection stops, choose **Retry connection**.

Each bound row has its own target, **IM conversation** switch and **Options**. Change the target, busy behavior, message text mode, approvals and questions, or restore the binding default there. Editing or confirming a paused binding does not turn it back on; enable it explicitly and check its conversation switch. The row's **⋯** menu offers **Test binding** (sends a fixed test message) and **Unbind**.

A group binding applies to the original sender by default; set **Group scope** to **Topic** or **Whole chat** to widen it. Topic and whole-chat bindings also have a **Group wake policy**: by default they wake on **@ or reply**, or you can choose **All messages**, **Manual only**, or set **Wake prefixes**. Field details are in [IM account and channel bindings](../server/rest-api.md#im-account-and-channel-bindings).

New bindings default to **Immediate**: while a turn is busy, Kiki attempts to insert the message at the next safe step boundary. In **Options**, choose **Queue** to wait, or **Steer** to retain the earlier insertion preference; saved choices are not reset. When the current turn cannot accept a message, it remains queued or starts its own turn, and Kiki reports a queued message as queued. Send `/help` in the bound chat for available commands: `/status` reads session activity, `/abort` stops the current turn, and `/target` lists binding targets (confirm a change in Kiki). Unknown slash commands return guidance instead of becoming agent prompts.

The phone can show the full visible text when the turn settles, or the text already written. Several questions stay together until each one has an answer. Approvals and questions can be answered from the phone, including after Kiki restarts, as long as they are still open. On QQ and WeChat, each number answers the next open question, and words that are not one of the choices stay with that question. A sign-in that asks for a password stays on the desktop SSH screen. If Kiki restarts before the phone has the whole visible text, the rest of that text still arrives. The turn is not started again.

QQ and WeChat use full-text replies without message editing or buttons; answer questions with the numbered choices. QQ cannot take a file, and the generic OneBot bridge has no identifiable message-too-long error category. A rejected QQ reply is not marked as delivered, and the complete reply remains available on the desktop. Kiki does not treat an unknown failure as a length rejection and automatically resend it in pieces. When WeChat rejects a message as too long, the full text goes out as one file. A voice the platform cannot send as voice is sent as the original file, and that difference is counted on its own.

One-way notification channels are unchanged. If the bot already has a webhook, the page says so and leaves the webhook in place.

## What stays on this computer

The token is stored with the existing notification credential. It is not written into the conversation or the diagnostic log. A message from someone you have not bound is counted and does not start a turn.
