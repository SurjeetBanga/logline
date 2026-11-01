# Privacy and usage data

Logline keeps the logs it captures on your machine. Apart from what you share with an agent or fetch from a connection you added, the only thing it sends is **anonymous usage counts**, so the people who build it can see which features are used, where they are slow, and where they fail.

## What is sent

Usage counts are events such as "a terminal capture started", "the Traces view was opened", or "an agent called `logline_search_logs` and it took 25 to 49 ms". Each property is a fixed choice, true or false, or a bucket such as `10-99`, never an exact number. [telemetry.json](telemetry.json) lists every event and property, and **Logline: Show Usage Data** shows every event sent from your window.

Every event carries:

- An anonymous ID: a random value Logline makes for each VS Code profile, and for each remote host it runs on, such as an SSH server or a container. It is not your VS Code machine ID, is not shared with other extensions, and is never tied to your name, account, or email.
- When it happened, to the minute.
- The Logline and VS Code versions; the editor (VS Code, Cursor, Windsurf, VSCodium, or other); desktop or web; local, SSH, WSL, container, or Codespaces.
- The operating system and processor type, the number of CPU cores in a range (such as 5-8), and the memory in a range (such as 16-31 GB).

Events cover:

- **Use**: the day you first use Logline each day, the commands you run, the kinds of capture you start, the views you open, whether you finished or skipped the panel tour, and the first time you reach a few steps such as your first search or first share.
- **Searches**: which operators a search used (fields, `-`, regex, time ranges, comparisons, `*`, `changed:`, `OR`) and which of Logline's own fields it filtered on, such as `level` or `service`. Never what you searched for, and never your own field names.
- **Connections**: the type (Datadog, Postgres, and so on), how it signs in, and whether a search, tail, query, or test worked, with its time and row count in ranges.
- **Log doctor**: which kinds of problem it found, such as a secret or a noisy statement, once a session; the actions you take on them; and a thumbs up or down you give a kind of finding. Never the statement, file, or value.
- **Agents**: when you share logs, how (all, chosen runs, or one event) and how much in ranges; which kind of agent called (Claude Code, Codex, Cursor, Copilot, or other); which tool it called, whether it worked, and how long it took.
- **Settings**: which Logline setting changed, and its new value only when it is on or off, a number in a range, or one of the setting's own choices.
- **Was it helpful**: a few minutes after **Ask Copilot** opens an investigation, Logline may ask whether it helped, at most once a week and three times in all, and sends Yes or No. Never the chat.
- **Performance and errors**: how long activation, the first logs in the panel, searches, and imports took, and how many events an import brought, in ranges; and failures by area and a code Logline names, never their message.
- **A daily summary**: active minutes, searches, events captured, sources, memory used, connections by type, and agent use, all in ranges.

## What is never sent

Log content. Search text or queries, including SQL, Datadog, and other connection queries. File paths, workspace or folder names, and git details. Connection names, hosts, ports, databases, indexes, and user names. Tool inputs and results, and prompts. Your IP address is discarded, and no location is derived from it.

## Suggestions and votes

**Suggest a feature…** and **Vote on what's next…**, in **More actions** in the Logs panel or the Command Palette, open a short form in the panel. Nothing is sent until you press **Send**, and a suggestion shows exactly what will be sent. Before it leaves, Logline replaces credentials, email addresses, phone and long numbers, IP addresses, host names, URLs, and file paths, as you see in the form. Still, leave out anything that identifies you or your company. A suggestion and a vote are the only text Logline sends, and each is sent under a one-time ID of its own, so it cannot be tied to your anonymous ID or your usage counts.

With usage counts off, or if sending fails, the form offers a GitHub issue instead. A GitHub issue is public and shows your GitHub account, so read it before you submit it.

## Where it goes

Events are sent in batches about once a minute over HTTPS to [PostHog](https://posthog.com) in the EU (`eu.i.posthog.com`), and kept for 12 months. If a batch cannot be sent it is dropped; nothing is stored on disk to send later. Administrators can block that host.

## Turning it off

Usage counts follow VS Code's `telemetry.telemetryLevel`: they need `all`, and error codes need `error` or `all`. To turn them off for Logline only, set `logline.telemetry.enabled` to `false` in your user settings; a workspace or folder's settings cannot turn them back on. `DO_NOT_TRACK=1` in the environment turns them off too. Turning them off drops anything not yet sent.

## Deleting your data

Run **Logline: Show Usage Data** to see your anonymous ID, and email it to logline.dev@icloud.com, privately rather than in a public issue, asking for its data to be deleted. Its events are deleted where PostHog allows, and otherwise excluded from every report and left to expire with the rest after 12 months. To remove a suggestion you sent, quote it in the email: suggestions do not carry your anonymous ID. **Logline: Reset Usage ID** starts a new ID, so later events cannot be tied to earlier ones.
