# Logline

A VS Code extension that captures logs from terminals, debug sessions, tasks, files, and OpenTelemetry into one searchable view, and shares them with AI agents. [CONTRIBUTING.md](CONTRIBUTING.md) is the contributor guide and [ARCHITECTURE.md](ARCHITECTURE.md) the design reference; read the parts you need before changing code.

## Commands

- `npm run check`: compile, typecheck, lint, format check, and unit tests. Run it before you finish.
- `npm run format`: format with Prettier.
- `npm test`: unit tests only.
- `npm run smoke`: the extension in a real VS Code; needs a desktop VS Code, or `VSCODE_VERSION=stable` to download one.

## Rules

- Layers: `src/core` imports no other layer; `capture`, `storage`, `transfer`, and `protocol` import only `core`; `src/mcp` imports only `protocol`; `src/webview` imports only `core` at runtime; only `src/vscode` and `src/extension.ts` import `vscode`. `src/architecture.test.ts` enforces this.
- Tests sit next to the module they test. Build secret-shaped strings (tokens, keys) at runtime, never as literals: GitHub push protection rejects them.
- After changing `src/webview/`, run `npm run compile` and commit the regenerated `media/viewer.js`.
- Describe user-facing changes under `## Unreleased` in `CHANGELOG.md`, and update `docs/usage.md` when behavior or settings change.
- Describe features on their own terms in docs, changelogs, commits, and pull requests; do not say they were borrowed from another product.

## Commits and pull requests

- Author commits as `Surjeet Banga <31071557+SurjeetBanga@users.noreply.github.com>`.
- Do not add `Co-Authored-By`, `Claude-Session`, or other AI attribution trailers to commit messages.
- Do not add "Generated with …" footers, or agent session links, to pull request descriptions, commit messages, or comments.
