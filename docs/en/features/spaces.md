---
title: Spaces, Remote Links & SSH
---

# Spaces, Remote Links & SSH

Kiki runs where you run it, and the things it can reach are yours to decide. This page covers the four places that reach: **spaces** on this computer or other computers; **pairing**, which connects two spaces across computers with explicit approval on each side; **thread messages**, which let one space send messages into another without browsing it; and **device access**, which opens this space in a browser or phone app. It ends with in-session SSH, the one reach that is just a session's own resource.

Nothing here is a relay through someone else's server. Sessions live under the space's home directory on the computer running Kiki; a pairing or a browser link is a door you open, with a credential you can revoke.

## Spaces & work modes {#spaces-the-kikis-you-open}

A **space** is one independent set of conversations, memory, and workspaces. Each computer starts with **Main space**, which manages the spaces registered on that computer. Each space has its own shortcuts, window behavior, and credential scope, so a work space and a personal space can sit side by side without sharing what they can sign in to.

Credentials are the decision each subspace makes. **Shared** means the subspace reuses **Main space**'s credentials; **isolated** means it keeps its own, so signing into a personal account in one subspace does not change the other. The space settings detail also shows, per item, what the space follows and what it fixes, so you can see whether a value is inherited or pinned. You can copy SSH profiles from one space into another, or copy one here, without moving anything by hand.

**Settings → Spaces & devices → Spaces** lists the spaces you can open: spaces on this computer, paired spaces on other computers, owner (SSH) profiles for computers you administer directly, and the desktop window preference (**Switch in this window** or **Open in a new window**) under **This device**. **Settings → Spaces & devices → Access** controls who may connect into this space (**Devices**, **Other spaces**, and **External clients**), and **Settings → Spaces & devices → This device's connection** shows how this window reaches the server. Change a subspace's credential scope on its own card in **Settings → Spaces & devices → Spaces**. See [Settings pages](/en/guides/settings) for the other sections of that dialog, and [Models, Prompts & Permissions](/en/features/freedom) for what those credentials reach.

A **work mode** is a working surface inside a space, not another data boundary. The mode picker offers Kiki and Work by default; explicitly setting `KIKI_EXPERIMENTAL_WORK_PRESETS=false` or `[experimental] work_presets = false` keeps it off. Each space has its own Work setup, name and preferred task. Selecting Work offers Office, writing, extraction and table-check starters; its setup shows the packages that are actually installed and asks before installing missing packages or OfficeCLI. A failed setup retains the packages that succeeded so you can retry the rest. Switching modes does not change an existing session's model, profile or permissions, and removing a mode keeps its documents, sessions and shared plugins.

On desktop, **Open in new window** opens another mode in the same space. Its route and mode belong to that window, while the space's service is shared; closing one window does not stop background work. Explicit restart or update asks about the affected space's other windows and unfinished work before cancelling and draining it. A daemon managed outside the desktop app must be stopped through its own owner instead.

![The spaces list: the main space beside two registered spaces, one sharing accounts and one isolated.](/shots/spaces/ps-20261005-spaces-list.en.png)

![One space's own settings sheet, where each row says whether it follows the main space or is set here, with a Change action per row.](/shots/spaces/ps-20261005-spaces-detail.en.png)

![Choosing a space's credential scope: share the main space's accounts and keys, or keep this space's separate.](/shots/spaces/ps-20261005-spaces-credentials.en.png)

## Pairing spaces across computers

A pairing is a directed link from one space to a space on another computer. It is not a shared login: the target space has its own identity and must approve the source before anything flows. Outbound pairings — the spaces on other computers you open from here — live under **Settings → Spaces & devices → Spaces**; inbound grants — the spaces and devices allowed to connect here — live under **Settings → Spaces & devices → Access → Other spaces**.

Receiving is off by default. In the GUI, **Pairing code** under **Settings → Spaces & devices → Access → Other spaces** opens a sheet that states what the other side will be able to do before any code is issued, and notes that generating a code turns on **Allow other spaces to connect** and lets the computer accept pairing on the local network and Tailscale until you turn that switch off. **Open this space (browse and chat)** is always included; **Message this space's threads, and start a model run here** is unchecked by default, and thread messages are requested or granted in the GUI only when ticked. On the connecting side, **Pair a space** (in the space switcher or **Settings → Spaces & devices → Spaces**) redeems the ten-minute `XXXX-XXXX` code or a `kiki://pair?endpoint=<encoded>&code=<encoded>&fp=<fingerprint>` QR payload for a dedicated per-peer credential without sharing the server's owner token; a successful pairing keeps you in your current space and offers **Switch** when you want to enter the new one. The QR payload includes a SHA-256 fingerprint of the target's public key. Kiki accepts only a matching certificate before sending the pairing code or peer token.

The suggested LAN address stays `http://` because the same listener serves browsers and the phone app over HTTP. Space pairing and later peer traffic use TLS (the protocol that encrypts the connection) on that port when the target supports it. When you enter a direct pairing code manually, Kiki tries TLS first and shows the first-seen fingerprint on the saved pairing for you to verify. It falls back to legacy HTTP only for an unpinned manual pairing when the target does not support TLS; a pinned pairing never downgrades. Existing unpinned HTTP pairings remain supported, but their peer proof neither encrypts later HTTP traffic nor prevents an active relay. Browser and phone traffic on HTTP has the separate limits described under [Device access in a browser](#device-access-in-a-browser).

Before a saved connection sends bearer credentials, Kiki checks the target home identity and a nonce-based proof derived from the pairing grant. Background summary reads use the same check.

Re-pairing from the same source revokes all previously approved grants for that source and closes their active connections. It also revokes thread-message permissions bound to those pairing grants, but leaves standalone permissions intact. The new pairing choice determines whether a new pairing-bound thread-message permission is created.

Kiki keeps the existing saved pairing and its label when no new label is supplied, along with its background-summary setting and shared-space/bookmark choices. Approved peer grants do not expire automatically. Over REST, `POST /api/remote-connections/pair` accepts an optional `requestBridge` boolean (omitted means requested, matching earlier clients; `false` claims space-opening access without requesting thread messages, as the phone app and the unchecked GUI sheet do).

From the terminal, `kiki pair` keeps its existing default: running `kiki pair` on the target enables inbound access, binds a direct peer listener on reachable LAN and Tailscale interfaces alongside the local daemon, and prints a ten-minute pairing code that allows thread messages; running `kiki pair <endpoint> <code>` on the source claims the peer credential and requests a one-way thread-message channel from the current workspace to the target's most recently opened workspace. Over SSH, pick a host or enter `user@host` (or run `kiki connections ssh connect --host user@host`) to inspect, start or attach the remote daemon, issue a dedicated peer credential, and set up the connection in one step; both computers need the same connection protocol version, while Kiki build versions and release channels may differ.

Every pairing row in Settings shows its connection state, its last-known measurements, whether the space can be opened, and the thread-message direction (**both ways**, **outgoing only**, **incoming only**, or **none**). Each row's menu can open **Thread messages…** to turn an existing thread-message permission off or revoke it on its own without removing the pairing, alongside connection-level enable, disable, retry, and remove actions. Revoking a pairing grant on the target (`inbound revoke <grantId>`) stops that peer's browsing, streams, and the thread-message permission created with that pairing, without touching other approved sources or standalone permissions; `inbound disable` closes all peer access while keeping the allow list. Removing an outbound pairing releases local credentials and owned tunnels without stopping the remote daemon or undoing work already started there. An offline space keeps its last-known measurements and their timestamp rather than reporting invented zeros.

For scripted or step-by-step control, the explicit invitation and SSH planning commands remain available: `inbound invite` issues a one-use invitation for a known source identity; when a client adds that invitation, it verifies the invitation and target identity before sending the owner's token. `ssh plan` queries a remote computer without changing it, and `ssh execute PLAN_ID` attaches (or starts the remote daemon only when `--ensure` is passed). Kiki does not install remote software for you.

If the target computer is temporarily unreachable, the phone app reconnects automatically and keeps your open conversation and draft in place. You can also retry or switch computers. If the target turns off **Allow other spaces to connect**, ordinary reads recover when its owner turns it back on. A refused operation does not sign you out, and Kiki does not automatically repeat refused or unconfirmed writes. If your token is invalid or the grant is revoked, pair again or update the connection's authorization before retrying.

See [`kiki pair`](/en/reference/command#kiki-pair), [`kiki connections`](/en/reference/command#kiki-pair), and [`kiki bridges`](/en/reference/command#kiki-bridges) for the command reference behind these settings.

![The paired spaces list: one row per space on another computer, each with its own state and the moment its last reading was taken.](/shots/spaces/ps-20261005-spaces-remote.en.png)

![The gate deciding which other spaces may connect here — off by default, with each allowed space listed and revocable.](/shots/spaces/ps-20261005-spaces-inbound.en.png)

## Thread messages

Thread messages travel over a one-way permission between two spaces (managed on the command line with `kiki bridges` and over HTTP at `/api/thread-bridges`). When a pairing includes thread messages — such as `kiki pair` or `kiki connections ssh connect` from the CLI — the default permission from the source workspace to the target's active workspace carries `read`, `send`, and `wait` only; `wake` (which lets a sent message start a model turn on the receiving side) is included only when explicitly granted, and without `wake` sent messages stay pending until someone opens or runs the thread. Ticking **Message this space's threads, and start a model run here** when generating a pairing code in the GUI explicitly grants `read`, `send`, `wait`, and `wake`. You can also approve narrower standalone permissions with exact source and target scopes, chosen operations, and an expiry.

A standalone thread-message permission never grants access to open and browse the space; in Settings, a connection that carries only thread messages shows **Can't be opened** instead of **Switch**. You can revoke a pairing's incoming or outgoing thread-message permission on its own from **Thread messages…** on the pairing row in **Settings → Spaces & devices → Spaces** or **Access → Other spaces**, while revoking the pairing grant itself also revokes the thread-message permission created with that pairing and leaves separately approved permissions intact. Receipts distinguish source pending, target accepted, prompt delivered, and rejection — delivered means the prompt arrived, not that a model replied. Pending sends keep their original key and sequence while retrying, and `retry` checks the durable queue rather than creating a new message. Revoking thread messages does not delete any session.

See [`kiki bridges`](/en/reference/command#kiki-bridges).

## Device access in a browser

Web access opens **this** space in a browser on another device. Whoever holds the link can use the space in full, with the same access you have — it is not a read-only share, and a temporary entry is temporary only in how long it stays open.

Turn it on under **Settings → Spaces & devices → Access → Devices**, or from the terminal with `kiki web --temporary` (the default: open for eight hours, then close by itself) or `kiki web --persistent` (stay open until you turn it off). `kiki web` opens the door on the shared daemon, starting the daemon first if needed, and the command returns at once instead of holding the terminal. Each run prints a single-use link that is valid for ten minutes and signs one browser in; Kiki redeems it for a session cookie held by the browser itself, keeps only a digest, and shows the link once — a lost or used link is replaced by a new one rather than looked up. Every new device needs a new link; in the GUI that is **New link for another device**. `kiki web --revoke [session-id]` signs out one browser or all of them. Turning Web access off revokes every link and every browser session; it does not stop the daemon, the desktop app, or the TUI, and it does not cancel work already started.

Browser and phone access to the direct LAN listener uses plain HTTP, so anyone on the same network can read what is sent. The `--insecure-no-tls` option also serves HTTP without encryption. TLS used for space pairing does not protect either HTTP path. For anything beyond a network you trust, put a TLS-terminating reverse proxy in front and pass `--public-url <https://…>`.

Web access and space pairings are different objects. A paired space on another computer has its own identity and a per-source grant you approve; a browser link is device access to this space, owned by whoever owns this computer. Turning Web access on does not admit any other space, and signed-in browsers can switch only to paired spaces you explicitly share on the **Devices** tab.

See [Use Kiki in a browser](/en/server/local-server#use-kiki-in-a-browser).

![Device web access turned on for this space, with the browsers already signed in listed beneath it.](/shots/spaces/ps-20261005-spaces-web-access.en.png)

## In-session SSH

A session can hold SSH hosts. Use the input box's **+** menu to add one. The **SSH** control above the input box shows how many hosts are joined, lists them, and takes one away on **X**; clicking **SSH** itself opens the session's host panel, one row per host with an **Enabled / Off** switch and that host's own connection state, where you can add or remove hosts. With more than three joined, the row folds by default and **Show all (n)** lists them, so the hosts never crowd the input box. A joined host is a resource of that session, not something each message carries — so the timeline does not fill with host bubbles, and removing a host removes it from the session rather than from your computer.

The control appears only once the session holds a host. A session that has joined none has no SSH line above its input box, and the **+** menu is still the way to add the first one. It stays on screen for as long as the host is joined, including between turns, because "joined" is the session's own state rather than whether a request happens to be running.

Adding a host puts it in the session's context; it does not connect to it. In a new session, picking a host in the **+** menu shows the same **SSH** control before the first message, and the hosts you selected are joined to the created session before that message is sent.

An agent can also name a configured host directly in a tool call, without adding it first. Main agents and subagents use the same connection-approval flow; hiding a host, rejecting a request, host-key verification and file permission rules still apply. Removing a host from the context does not revoke an already approved connection.

File paths belong to the selected host. On a Windows SSH host, use an absolute path such as `E:/work/result.log`; `Read`, `Write` and `Edit` use SFTP (SSH file transfer), while `Bash`, `Glob` and `Grep` use that host's PowerShell, so commands take PowerShell syntax and Git Bash is not needed on the remote host. A failing remote command reports its error instead of returning an empty result.

![The SSH panel above the input box, listing the hosts joined to this session and the ones still available to add.](/shots/spaces/ps-20261005-spaces-session-ssh.en.png)

See [Interface overview](/en/guides/interface#input-box) for the SSH control and the send-timing menu beside it.

## Next steps

- [`kiki pair` and `kiki connections`](/en/reference/command#kiki-pair) and [`kiki bridges`](/en/reference/command#kiki-bridges) — the command reference behind these settings
- [Use Kiki in a browser](/en/server/local-server#use-kiki-in-a-browser) — device web access in detail
- [Settings pages](/en/guides/settings) — the rest of the dialog, including Spaces & devices
