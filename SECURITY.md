# Security policy

## Supported versions

Fixes are released for the latest version of Logline only. Update to the latest release before reporting.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/SurjeetBanga/logline/security/advisories/new). Do not open a public issue.

Include:

- The Logline version, editor, and operating system.
- What an attacker can do, and what they need first (for example, a malicious workspace, another local user, or a process on the same machine).
- Steps or a proof of concept to reproduce it.

You will get a reply when the report has been reviewed. If it is confirmed, the fix is released as a new version, the advisory is published with it, and you are credited unless you ask not to be.

## Scope

Logline runs inside the editor, captures output from your programs, and can share it with AI agents. Reports about these protections are especially welcome:

- **Redaction**: logs shared with agents and redacted exports hide credentials, tokens, and passwords. A secret that reaches an agent or a redacted export is a vulnerability.
- **Sharing with agents**: agents read only what **Share with agent** shares, and nothing after **Stop sharing**.
- **The local agent bridge**: each editor window listens on `127.0.0.1` with a random per-window token and keeps its discovery files in `~/.logline/agents/`, readable only by your user. Another user or an unauthenticated process reaching a window's logs is a vulnerability.
- **The OpenTelemetry receiver** accepts connections from the local machine only.
- **Persisted logs**: `.logline/latest.log` is unredacted and readable only by your user.

Not vulnerabilities:

- Running commands from a workspace's settings or tasks. Logline requires a trusted workspace for this, as VS Code tasks do.
- Secrets visible in the Logs panel itself, which shows your own output as it was printed.
