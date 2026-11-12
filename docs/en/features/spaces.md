---
title: Spaces, Remote Links & SSH
---

# Spaces, Remote Links & SSH

Kiki runs where you run it, and the things it can reach are yours to decide. This page covers the four places that reach: **spaces**, which model the Kikis you open; **remote connections**, which point one Kiki at another with an approval on each side; **thread bridges**, which let one Kiki send messages into another without being able to browse it; and **Web access**, which opens this Kiki in a browser. It ends with in-session SSH, the one reach that is just a session's own resource.

Nothing here is a relay through someone else's server. Sessions live under your Kiki home on the machine the server runs on; a remote connection or a web link is a door you open, with a credential you can revoke.

## Spaces & work modes {#spaces-the-kikis-you-open}

A **space** is one Kiki you work in. The main space manages the list; the spaces themselves are what you open. Each one can have its own shortcuts, its own window behavior, and its own credential scope, so a work Kiki and a personal Kiki can sit side by side without sharing what they can sign in to.

Credentials are the decision each subspace makes. **Shared** means the subspace reuses the main space's credentials; **isolated** means it keeps its own, so signing into a personal account in one subspace does not change the other. The space settings detail also shows, per item, what the space follows and what it fixes, so you can see whether a value is inherited or pinned. You can copy SSH profiles from one space into another, or copy one here, without moving anything by hand.

Change the credential scope on the subspace's own card in **Settings → Spaces**. See [Settings pages](/en/guides/settings) for the other sections of that dialog, and [Models, Prompts & Permissions](/en/features/freedom) for what those credentials reach.

A **work mode** is a working surface inside a space, not another data boundary. The mode picker offers Kiki and Work by default; explicitly setting `KIKI_EXPERIMENTAL_WORK_PRESETS=false` or `[experimental] work_presets = false` keeps it off. Each space has its own Work setup, name and preferred task. Selecting Work offers Office, writing, extraction and table-check starters; its setup shows the packages that are actually installed and asks before installing missing packages or OfficeCLI. A failed setup retains the packages that succeeded so you can retry the rest. Switching modes does not change an existing session's model, profile or permissions, and removing a mode keeps its documents, sessions and shared plugins.

On desktop, **Open in new window** opens another mode in the same space. Its route and mode belong to that window, while the space's service is shared; closing one window does not stop background work. Explicit restart or update asks about the affected space's other windows and unfinished work before cancelling and draining it. A daemon managed outside the desktop app must be stopped through its own owner instead.

![The spaces list: the main space beside two registered spaces, one sharing accounts and one isolated.](/shots/spaces/ps-20261005-spaces-list.en.png)

![One space's own settings sheet, where each row says whether it follows the main space or is set here, with a Change action per row.](/shots/spaces/ps-20261005-spaces-detail.en.png)

![Choosing a space's credential scope: share the main space's accounts and keys, or keep this space's separate.](/shots/spaces/ps-20261005-spaces-credentials.en.png)

## Remote connections

A remote connection is a directed link from this Kiki's home to another Kiki home on another machine. It is not a shared login: the target has its own identity, and it must approve the source before anything flows. Both directions live under **Settings → Connection & remote → Access from elsewhere → Other Kiki**: **Kikis allowed to connect to me** on top, **Kikis I connect to** below.

Receiving is off by default. On the target, generate a single-use pairing code (`XXXX-XXXX`, valid for ten minutes) in **Settings → Connection & remote → Access from elsewhere → Other Kiki** or with `kiki pair`; doing so opens the inbound gate, starts a direct peer listener on reachable LAN and Tailscale interfaces alongside the local daemon, and shows the code, suggested direct addresses, and a scannable `kiki://pair?endpoint=<encoded>&code=<encoded>` QR payload. On the source, scan or paste that `kiki://pair` link, or enter the target address and pairing code (`kiki pair <endpoint> <code>`), to claim a dedicated per-peer credential and automatically set up a one-way thread bridge from the current workspace to the target's most recently opened workspace (`requestBridge: false` claims GUI access only, such as from a phone), without sharing the server's global owner token. Over SSH, pick a host or enter `user@host` (or run `kiki connections ssh connect --host user@host`) to inspect, start or attach the remote daemon, issue a dedicated peer credential, and install the thread bridge in one step; both hosts need the same connection protocol version, while Kiki build versions and release channels may differ. Every connection is one row with its own state, its last-known measurements, and actions that affect only that link: enable, disable, retry, or remove. Revoking a grant on the target (`inbound revoke <grantId>`) stops that peer's GUI reads, streams, and the thread bridge created with that pairing, without touching other approved sources or separate bridge grants; `inbound disable` closes all peer access while keeping the allow list. Removing a connection releases local credentials and owned tunnels; it does not stop the target daemon or undo work already started there. An offline target keeps its last-known measurements and their timestamp rather than reporting invented zeros.

For scripted or step-by-step control, the explicit invitation and SSH planning commands remain available: `inbound invite` issues a one-use invitation for a known source identity, `ssh plan` queries a remote host without changing it, and `ssh execute PLAN_ID` attaches (or starts the remote daemon only when `--ensure` is passed). Kiki does not install remote software for you.

If the target is temporarily unreachable, the mobile app reconnects automatically and keeps your open conversation and draft in place. You can also retry or switch computers. If the target closes inbound access, ordinary reads recover when its owner reopens it. A refused operation does not sign you out, and Kiki does not automatically repeat refused or unconfirmed writes. If your token is invalid or the grant is revoked, pair again or update the connection's authorization before retrying.

See [`kiki pair`](/en/reference/command#kiki-pair), [`kiki connections`](/en/reference/command#kiki-pair), and [`kiki bridges`](/en/reference/command#kiki-bridges) for the command reference behind these settings.

![The remote connections list: one row per peer Kiki, each with its own state and the moment its last reading was taken.](/shots/spaces/ps-20261005-spaces-remote.en.png)

![This Kiki's identity string, and the gate deciding which other Kikis may connect to it — off by default, with each allowed one listed and revocable.](/shots/spaces/ps-20261005-spaces-inbound.en.png)

## Thread bridges

A thread bridge is a one-way channel for thread messages between two homes. Pairing two Kikis with a pairing code or one-step SSH connect automatically sets up a bridge from the source workspace to the target's active workspace (`read`, `send`, `wait`, and `wake`). You can also manage narrower, standalone bridges explicitly: the target home approves the exact source and target scopes, the operations — `read`, `send`, `wait`, and `wake` only if you ask for it — and an expiry, and the bridge carries nothing else. Without `wake`, sends stay pending rather than starting a model turn on the other side.

A standalone bridge never grants GUI browsing access, and revoking a pairing grant revokes the bridge created with that pairing while leaving separately approved bridges intact. Receipts distinguish source pending, target accepted, prompt delivered, and rejection — delivered means the prompt arrived, not that a model replied. Pending sends keep their original key and sequence while retrying, and `retry` checks the durable queue rather than creating a new message. Revoking a bridge does not delete any session.

See [`kiki bridges`](/en/reference/command#kiki-bridges).

## Web access

Web access opens **this** Kiki from a browser on another device. Whoever holds the link can use it in full, with the same access you have — it is not a read-only share, and a temporary entry is temporary only in how long it stays open.

Turn it on under **Settings → Connection & remote → Access from elsewhere → Web access**, or from the terminal with `kiki web --temporary` (the default: open for eight hours, then close by itself) or `kiki web --persistent` (stay open until you turn it off). `kiki web` opens the door on the shared daemon, starting the daemon first if needed, and the command returns at once instead of holding the terminal. Each run prints a single-use link that is valid for ten minutes and signs one browser in; Kiki redeems it for a session cookie held by the browser itself, keeps only a digest, and shows the link once — a lost or used link is replaced by a new one rather than looked up. Every new device needs a new link; in the GUI that is **New link for another device**. `kiki web --revoke [session-id]` signs out one browser or all of them. Turning Web access off revokes every link and every browser session; it does not stop the daemon, the desktop app, or the TUI, and it does not cancel work already started.

Plain LAN HTTP (`--insecure-no-tls`) is not encrypted: anyone on the same network can read what is sent. For anything beyond a network you trust, put a TLS-terminating reverse proxy in front and pass `--public-url <https://…>`.

Web access and remote connections are different objects. A remote Kiki is another Kiki with its own identity and a per-source grant you approve; a web link is access to this one, owned by whoever owns this machine. Turning Web access on does not admit any Kiki.

See [Use Kiki in a browser](/en/server/local-server#use-kiki-in-a-browser).

![Web access turned on for this Kiki, with the browsers already signed in listed beneath it.](/shots/spaces/ps-20261005-spaces-web-access.en.png)

## In-session SSH

A session can hold SSH hosts. Use the input box's **+** menu to add one. The **SSH** control above the input box shows how many hosts are joined, lists them, and takes one away on **X**; clicking **SSH** itself opens the session's host panel, one row per host with an **Enabled / Off** switch and that host's own connection state, where you can add or remove hosts. With more than three joined, the row folds by default and **Show all (n)** lists them, so the hosts never crowd the input box. A joined host is a resource of that session, not something each message carries — so the timeline does not fill with host bubbles, and removing a host removes it from the session rather than from your machine.

The control appears only once the session holds a host. A session that has joined none has no SSH line above its input box, and the **+** menu is still the way to add the first one. It stays on screen for as long as the host is joined, including between turns, because "joined" is the session's own state rather than whether a request happens to be running.

Adding a host puts it in the session's context; it does not connect to it. In a new session, picking a host in the **+** menu shows the same **SSH** control before the first message, and the hosts you selected are joined to the created session before that message is sent.

An agent can also name a configured host directly in a tool call, without adding it first. Main agents and subagents use the same connection-approval flow; hiding a host, rejecting a request, host-key verification and file permission rules still apply. Removing a host from the context does not revoke an already approved connection.

File paths belong to the selected host. On a Windows SSH host, use an absolute path such as `E:/work/result.log`; `Read`, `Write` and `Edit` use SFTP (SSH file transfer), while `Bash`, `Glob` and `Grep` use that host's PowerShell, so commands take PowerShell syntax and Git Bash is not needed on the remote host. A failing remote command reports its error instead of returning an empty result.

![The SSH panel above the input box, listing the hosts joined to this session and the ones still available to add.](/shots/spaces/ps-20261005-spaces-session-ssh.en.png)

See [Interface overview](/en/guides/interface#input-box) for the SSH control and the send-timing menu beside it.

## Next steps

- [`kiki pair` and `kiki connections`](/en/reference/command#kiki-pair) and [`kiki bridges`](/en/reference/command#kiki-bridges) — the command reference behind these settings
- [Use Kiki in a browser](/en/server/local-server#use-kiki-in-a-browser) — Web access in detail
- [Settings pages](/en/guides/settings) — the rest of the dialog, including Connections
