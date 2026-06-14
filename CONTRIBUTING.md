# Contributing to StateFlow

Thanks for your interest in contributing! This document explains how to get set up and
what we expect from contributions.

## Getting started

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the test suite to make sure everything is green:
   ```bash
   npm test
   ```

## Project layout

- `src/` — the library source. Public exports are defined in `src/index.ts`.
- `src/.tests/` — the test suite (vitest, files named `*.spec.ts`).
- `docs/` — the documentation website (a separate Next.js app with its own dependencies).

## Development workflow

```bash
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run typecheck  # type-check with tsc (no emit)
npm run lint       # lint + format check with Biome
npm run format     # auto-format with Biome
npm run build      # bundle with tsup and emit declarations with tsc
npm run watch      # rebuild on change
```

### Before opening a pull request

- **Tests pass.** Run `npm test` and add tests for any new behavior or bug fix.
- **It type-checks and lints.** Run `npm run typecheck` and `npm run lint` (auto-fix formatting with `npm run format`).
- **It builds.** Run `npm run build` and make sure there are no type errors.
- **The public API stays intentional.** If you add or change an export in `src/index.ts`,
  call it out in your PR description.
- **Docs stay in sync.** If you change public behavior, update the relevant page under
  `docs/src/app/docs/`.

## Commit messages & PRs

- Keep commits focused and write clear messages describing the *why*, not just the *what*.
- Reference any related issue in the PR description.
- Fill out the pull request template.

## Reporting bugs

Open an issue using the **Bug report** template and include a minimal reproduction — ideally
a small snippet using `defineSignal` / `defineState` / `defineFlow` that demonstrates the
problem.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
