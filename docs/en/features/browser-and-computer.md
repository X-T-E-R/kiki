---
title: Browser & Computer Control
---

# Browser & Computer Control

When work moves beyond local text files into live web pages, signed-in dashboards, or desktop software that has no CLI or API, you can set up and enable browser and computer control under **Settings → Capabilities → Browser & computer** (and matching plugins).

Kiki's browser driver, any independent browser it starts, and computer control run on the Kiki server machine, while you can also attach to an existing local or remote browser. For the full settings walkthrough, see [Browser control](/en/guides/settings#browser-control) and [Computer control](/en/guides/settings#computer-control).

## Browser control {#browser-control}

Once you complete the component setup and check the browsers an agent may use under **Settings → Capabilities → Browser & computer → Browser control**, agents can open pages, read snapshots, click elements, fill forms, and take screenshots through the [browser tools](/en/reference/tools#browser-tools), attaching screenshots or recordings back to the timeline. Connections start only when a task requests them.

You can connect the kind of browser that fits the job:

- **Your everyday signed-in browser (Kimi / Codex browser extensions)**: use the **Kimi Browser Extension** or **Codex / ChatGPT browser extension** to drive the browser you already use, keeping your existing sign-ins and cookies for internal dashboards, social research, form filling, and cross-site collection. Kiki prepares the local bridge components, and you add and approve the extension from your browser's store.
- **Kiki-managed independent browser**: Kiki starts and manages a separate browser and sign-in profile on the server without copying your everyday cookies. It is suited for automated verification, stateless browsing, or tasks that need an isolated account. It runs headless by default, with an option to show the browser window.
- **Ego Lite**: if you install Ego Lite yourself and finish its setup window, Kiki can check its readiness and connect it so agents can run page automation scripts with screenshots attached directly to the timeline.
- **Existing or remote browsers (CDP)**: under **+ Add browser → Add manual connection**, attach directly to any local or remote browser that already exposes a CDP address without launching a new browser instance.

### Browser permissions

Each browser source has an enable switch for that integration method (turning a source off stops discovery, connection, and tool calls for it while preserving your checked browsers), and each browser in the connection list has an **Allow agent use** checkbox. An agent can use only the browsers you check, and clearing a checkbox revokes that access immediately. You can allow several browsers at once and pick one in **Default connection** at the top of the list for new sessions, or choose **Choose each time** so each call names its browser explicitly.

See [Settings pages: Browser control](/en/guides/settings#browser-control) for route setup and readiness checks, and [Built-in Tools: Browser Tools](/en/reference/tools#browser-tools) for tool parameters.

## Computer control {#computer-control}

For desktop apps without a CLI or API, cross-app data entry, or visual UI walkthroughs, Kiki provides two desktop control paths. Neither installs or connects to your desktop automatically; both require your manual installation and approval before use:

- **Built-in computer control ([Settings → Capabilities → Browser & computer → Computer control](/en/guides/settings#computer-control))**: downloads and verifies a pinned open-source executor on the Kiki server and registers a desktop control connection. **Model usage preference** defaults to **Avoid** (models prefer existing CLI, API, MCP, short-script, and browser tools unless you or your rules explicitly ask for desktop control) and can be switched to **Prefer** for interactive desktop tasks. The session's main agent can use the desktop tools under your permission rules, while subagents require an explicit opt-in.
- **[Kimi Computer Use plugin](/en/customization/plugins#kimi-computer-use)**: an official desktop plugin installed from a direct URL for clicking, dragging, scrolling, and typing in desktop apps. On macOS it runs silently in the background without taking over your mouse once you grant Accessibility and Screen Recording permissions in System Settings; on Windows (WinCU) it runs in an interactive desktop session without extra OS permission prompts, briefly activating the target window and using your real mouse and keyboard while acting.

## Next steps

- [Settings pages: Browser control](/en/guides/settings#browser-control) and [Computer control](/en/guides/settings#computer-control): route setup and status checks
- [Built-in Tools: Browser Tools](/en/reference/tools#browser-tools): snapshots, tab management, and script execution
- [Plugins: Kimi Browser Extension](/en/customization/plugins#kimi-browser-extension) and [Kimi Computer Use](/en/customization/plugins#kimi-computer-use): extension and desktop plugin installation
- [Plugins, Skills, MCP & Search](/en/features/extend): local document extraction, Office files, structured data, and web retrieval
