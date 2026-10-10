# Contributing to Logline

Thanks for helping. Bug reports, ideas, and pull requests are all welcome.

- **Bugs and ideas**: open an issue with the bug report or feature request form.
- **Security problems**: report them privately as described in [SECURITY.md](SECURITY.md).
- **Larger changes**: open an issue first so we can agree on the approach before you write the code.

## Set up

You need Node.js 22 (`nvm use` reads `.nvmrc`) and VS Code 1.99 or later.

```sh
npm ci
npm run check
```

Press **F5** and choose **Run Logline** to start an Extension Development Host with your build. `npm run watch` rebuilds as you edit.

## How the code is organized

[ARCHITECTURE.md](ARCHITECTURE.md) describes the layers, who owns what state, and how the host and the webview talk. The layer rules are enforced: `src/architecture.test.ts` fails when, for example, code in `src/core` imports `vscode`.

The webview's source is `src/webview/`. `npm run compile` bundles it into `media/viewer.js`, which is committed: rebuild and commit it with your change. CI fails if it is out of date.

## Checks

| Command | What it does |
| --- | --- |
| `npm run check` | Compiles, type-checks, lints, checks formatting, and runs the tests. Run it before opening a pull request. |
| `npm run format` | Formats the code with Prettier. |
| `npm run lint` | Finds promises that are neither awaited nor handled. |
| `npm test` | Runs the unit tests only. |
| `npm run smoke` | Starts a real VS Code with the extension and runs the smoke test. Set `VSCODE_VERSION=stable` to download VS Code instead of using your installed `code`. |

CI runs the checks and the tests on Linux, Windows, and macOS, then runs the smoke test on the packaged extension in VS Code 1.99.0 and the latest stable. A pull request can be merged only when **CI passed** is green.

## Tests

- Put a test next to the module it tests: `src/core/query.test.ts` tests `src/core/query.ts`.
- Test `core`, `capture`, and `storage` modules directly. Only tests of VS Code adapters need `withVscode` from `src/test/vscode-mock.ts`.
- Use made-up log data. Build strings that look like real credentials at runtime (for example, `['ghp', 'x'.repeat(36)].join('_')`), because GitHub blocks pushes that contain them literally.

## Changelog and documentation

- Describe user-facing changes under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md), in the section that fits: **Behavior changes**, **Changes**, **Performance**, **Security**, or **Fixes**. Write for users: what they can do now, or what works that did not.
- Update [docs/usage.md](docs/usage.md) when behavior or settings change, and [README.md](README.md) for headline features.

## Pull requests

- Keep each pull request to one change, and fill in the template.
- Write commit messages as an imperative summary of what the change does (`Report a failed read of a followed file instead of dropping it`), with a body that explains why when it is not obvious.
- Releases are made by the maintainer.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
