# Contributing to Fluux Messenger

Thank you for your interest in contributing to Fluux Messenger!

## Development Setup

### Prerequisites

- Node.js satisfying `engines.node` in [`package.json`](package.json)
- Rust (for Tauri desktop builds)
- npm

### Getting Started

```bash
# Clone the repository
git clone https://github.com/processone/fluux-messenger.git
cd fluux-messenger

# Install dependencies
npm install

# Build the SDK (required before running the app)
npm run build:sdk

# Start development server (web)
npm run dev

# Start development server (desktop)
npm run tauri:dev
```

## Dependency patches

`npm install` and `npm ci` apply the committed `patches/*.patch` files through
`patch-package --error-on-fail`, followed by an encoding contract check. Install
with dev dependencies and lifecycle scripts enabled before building Fluux. A patch
that cannot be applied must fail the install; resolve it before building, rather
than skipping `postinstall`. Re-run `npm install` after pulling changes to
dependencies or committed patches.

Every patch must start with an `Upstream: https://...` link to the upstream issue or
pull request intended to make it unnecessary. Keep that link in the patch itself,
before its first `diff --git` line, and restore it after regenerating a patch with
`npx patch-package <package>`. Also state the patch's removal condition in its
header: an upstream merge can precede a published fix. On dependency upgrades,
verify the published package's behavior without the patch, including compatibility
regressions, and remove the patch only when its removal condition is satisfied.

`patches/@xmpp+sasl-plain+0.14.0.patch` encodes PLAIN fields as UTF-8 before the
0.14.0 SASL layers serialize the binary string as base64. It deliberately leaves
`@xmpp/base64` unchanged so binary FAST responses remain intact. Its regression
test drives the installed client through both SASL and SASL2:

```bash
cd packages/fluux-sdk
npx vitest run src/core/saslPlainUtf8.test.ts
```

The [upstream fix](https://github.com/xmppjs/xmpp.js/pull/1122) was merged on
2026-04-13, but `@xmpp/base64@0.14.0` was published before it.
When a newer release appears, verify the candidate dependency combination without
this patch: it must send PLAIN fields as UTF-8 through both SASL and SASL2 **and**
preserve binary base64 encoding and decoding for FAST responses and challenges.
Retire the patch only if both conditions hold; a version increase or upstream
merge alone is insufficient. If PLAIN is fixed but binary behavior changes,
report that incompatibility to the maintainer instead of automatically upgrading.
Once both conditions are verified, remove the patch when upgrading to avoid
encoding PLAIN fields twice.

Keep `scripts/check-xmpp-sasl-encoding.mjs` and its invocation in `postinstall`,
including its binary compatibility guard, as well as the SASL wire-encoding
regression tests after retiring the patch. The installation check enforces both
PLAIN UTF-8 and binary base64 compatibility, including when a textual patch still
applies to an incompatible dependency combination.

SASLprep and additional SCRAM mechanisms are separate changes.

## Project Structure

```
fluux-messenger/
├── apps/fluux/          # Desktop/web application
│   ├── src/             # React components and hooks
│   ├── src-tauri/       # Rust backend for Tauri
│   └── scripts/         # App build scripts
├── packages/fluux-sdk/  # Reusable XMPP SDK
└── scripts/             # Release scripts
```

## Contribution Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Your Changes

- Follow existing code style
- Add tests for new functionality
- Update documentation if needed

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run type checking
npm run typecheck

# Build to verify no errors
npm run build
```

### 4. Commit Your Changes

Write clear commit messages:

```bash
git commit -m "feat: add new feature description"
git commit -m "fix: resolve bug description"
git commit -m "docs: update documentation"
git commit -m "test: add tests for feature"
git commit -m "chore: update dependencies"
```

### 5. Create a Pull Request

- Push your branch to GitHub
- Open a Pull Request against `main`
- Fill in the PR template
- Wait for CI checks to pass

### 6. Merge

- PRs are squash-merged to keep history clean
- Each PR becomes a single commit on main

## Code Guidelines

### TypeScript/React

- Use functional components with hooks
- Prefer named exports
- Use TypeScript strict mode
- Follow existing patterns in the codebase

### SDK Design

The SDK (`packages/fluux-sdk`) should:
- Be framework-agnostic where possible
- Expose a clean public API via `index.ts`
- Handle all XMPP protocol details internally
- Apps should never import from `@xmpp/client` directly

### Testing

- Write unit tests for new functionality
- Use Vitest for testing
- Mock external dependencies
- Test files go next to source files (`*.test.ts`)

For correctness-sensitive changes, use the
[Fluux Messenger code-review checklist](docs/2026-07-23-fluux-code-review-checklist.md).
It captures recurring regressions around store semantics, MAM/read state, E2EE,
virtualized scrolling, lifecycle, and platform boundaries.

## Branching Strategy

### Feature Development

1. Create a feature or fix branch from `main`:
   ```bash
   git checkout -b feature/your-feature
   git checkout -b fix/your-bugfix
   ```

2. Open a Pull Request against `main`

3. After review, merge to `main` (squash merge)

### Releases

- When ready to release, tag directly on `main`:
  ```bash
  git tag -a v0.9.0 -m "Release v0.9.0"
  git push origin v0.9.0
  ```

### Hotfixes

If a critical fix is needed for a released version:

1. Create a hotfix branch from the release tag:
   ```bash
   git checkout -b hotfix/0.9.1 v0.9.0
   ```

2. Apply the fix and tag:
   ```bash
   git commit -m "fix: critical bug description"
   git tag -a v0.9.1 -m "Release v0.9.1"
   git push origin v0.9.1
   ```

3. Merge the fix back to `main`:
   ```bash
   git checkout main
   git merge hotfix/0.9.1
   ```

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones

## Contributor License Agreement

Before we can accept your contribution, you must sign our Contributor License Agreement (CLA). It is a one-time process.

**[Sign the CLA](https://cla.process-one.net)**

The CLA ensures that:
- You have the right to contribute the code
- ProcessOne can distribute your contribution under the project license
- Your contribution can be relicensed by ProcessOne in its Business offering.

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.
