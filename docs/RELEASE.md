# Release Process

This document describes how to prepare and publish a new release of Fluux Messenger.

## Overview

The release process uses a single authoritative source for changelog data, which is then used to generate all other release artifacts.

```
changelog.ts (authoritative)
       │
       ▼
npm run release:prepare X.Y.Z
       │
       ├──► CHANGELOG.md (full history)
       ├──► RELEASE_NOTES.md (current version only)
       └──► Version updates in all package files
```

## Files Involved

| File                                   | Role                                         |
|----------------------------------------|----------------------------------------------|
| `apps/fluux/src/data/changelog.ts`     | **Authoritative source** - Edit this first   |
| `CHANGELOG.md`                         | Generated - Full changelog for GitHub        |
| `RELEASE_NOTES.md`                     | Generated - Current version for auto-updater |
| `package.json`                         | Version number (root)                        |
| `apps/fluux/package.json`              | Version number (app)                         |
| `packages/fluux-sdk/package.json`      | Version number (SDK)                         |
| `apps/fluux/src-tauri/tauri.conf.json` | Version + bundleVersion                      |

## Step-by-Step Release

### 1. Update the Changelog

Edit `apps/fluux/src/data/changelog.ts` and add a new entry at the top of the array:

```typescript
export const changelog: ChangelogEntry[] = [
  {
    version: '0.9.0',
    date: '2026-01-15',
    sections: [
      {
        type: 'added',
        items: [
          'New feature description',
          'Another new feature',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Bug fix description',
        ],
      },
    ],
  },
  // ... previous versions
]
```

Available section types: `added`, `changed`, `fixed`, `removed`

### 2. Run the Release Preparation Script

```bash
npm run release:prepare 0.9.0
```

This will:
- Update version in all `package.json` files
- Update version and `bundleVersion` in `tauri.conf.json`
- Generate `CHANGELOG.md` from `changelog.ts`
- Generate `RELEASE_NOTES.md` for the auto-updater

### 3. Review the Changes

```bash
git diff
```

Verify that:
- All version numbers are correct
- `CHANGELOG.md` looks correct
- `RELEASE_NOTES.md` contains only the new version's notes

### 4. Commit the Release

```bash
git add -A
git commit -m "chore: release v0.9.0"
```

### 5. Create and Push the Tag

```bash
git tag -a v0.9.0 -m "Release v0.9.0"
git push origin main
git push origin v0.9.0
```

The tag push triggers the GitHub Actions release workflow.

## What Happens After Tagging

1. **GitHub Actions** builds the app for macOS, Windows, and Linux
2. Each build reads `RELEASE_NOTES.md` and uses it as the GitHub Release body
3. Binaries are signed with the Tauri signing key
4. `generate-update-manifest.js` creates `latest.json` with:
   - Version number
   - Release notes (from GitHub release body)
   - Download URLs and signatures for each platform
5. `latest.json` is uploaded to the GitHub Release

## Auto-Updater Flow

When users have the app installed:

1. On launch, the app fetches `latest.json` from GitHub Releases
2. Compares the manifest version with the installed version
3. If newer, shows an update modal with the release notes
4. User can download and install the update
5. Tauri verifies the signature before installing

## Script Options

```bash
# Basic usage
npm run release:prepare 0.9.0

# Also create the git tag
npm run release:prepare 0.9.0 --tag
```

## Troubleshooting

### "Version X.Y.Z not found in changelog.ts"

You need to add the changelog entry before running the script. The script warns but continues if the version isn't in `changelog.ts`.

### Build fails on GitHub Actions

Check that:
- The `TAURI_SIGNING_PRIVATE_KEY` secret is set
- The `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret is set
- All platform-specific secrets (Apple signing, etc.) are configured

### Auto-updater doesn't see the new version

- Verify `latest.json` was uploaded to the GitHub Release
- Check that the release is published (not a draft)
- The manifest URL in `tauri.conf.json` must match the release location

## Beta / Pre-release

Beta releases are published to GitHub but **do not trigger Tauri autoupdate** for existing users. This lets testers download and try new versions without pushing them to all users.

### How it works

1. Tags containing `-alpha.`, `-beta.`, or `-rc.` (e.g. `v0.14.0-beta.1`) are detected as prereleases
2. The GitHub Release is marked as **prerelease**, so it doesn't appear under `/releases/latest/`
3. The `latest.json` updater manifest is **not generated**, so the Tauri autoupdater never sees it
4. All platform binaries are still built, signed, and uploaded normally

### Branch workflow

Beta releases use a **release branch**:

1. **Create** a release branch from `main`:
   ```bash
   git checkout -b release/0.14.0 main
   ```
2. **Develop and stabilize** on the release branch — fix bugs, refine features
3. **Tag the beta** from the release branch (not from `main`)
4. **Promote to stable**: merge the release branch back to `main`, then tag the stable release from `main`

### Pre-flight checklist

Before running `release:prepare`, verify:

- [ ] Tests pass: `npm test`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] SDK builds cleanly: `npm run build:sdk`
- [ ] Changelog entry added in `apps/fluux/src/data/changelog.ts` with the beta version (e.g. `'0.14.0-beta.1'`)
- [ ] Review `git log` to confirm all intended commits are on the branch
- [ ] No untracked or uncommitted changes beyond what's intended for the release

### Beta release steps

```bash
# 1. Add changelog entry in changelog.ts with the beta version
#    version: '0.14.0-beta.1'

# 2. Run the prepare script with the beta version
npm run release:prepare 0.14.0-beta.1

# 3. Review generated files
git diff

# 4. Commit and tag
git add -A
git commit -m "chore: release v0.14.0-beta.1"
git tag -a v0.14.0-beta.1 -m "Release v0.14.0-beta.1"

# 5. Push the release branch and the tag
git push origin release/0.14.0 && git push origin v0.14.0-beta.1
```

The release workflow detects the `-beta.` suffix and automatically:
- Creates the GitHub Release with the **prerelease** flag
- Builds and uploads all platform binaries
- **Skips** `latest.json` generation (no autoupdate prompt)

Testers can download the beta from the GitHub Releases page directly.

### Local build verification (optional)

For a quick smoke test before pushing the tag:

```bash
npm run tauri:build
# or for a specific architecture:
./apps/fluux/scripts/tauri-build.sh --arm
```

Launch the built binary and verify basic functionality (connect, send a message, etc.).

### Promoting a beta to stable

When the beta is ready for general release:

1. Merge the release branch to `main`:
   ```bash
   git checkout main
   git merge release/0.14.0
   ```
2. Update the changelog entry to the stable version and run the prepare script:
   ```bash
   npm run release:prepare 0.14.0
   ```
3. Commit, tag, and push as usual:
   ```bash
   git add -A
   git commit -m "chore: release v0.14.0"
   git tag -a v0.14.0 -m "Release v0.14.0"
   git push origin main && git push origin v0.14.0
   ```
4. Delete the release branch:
   ```bash
   git branch -d release/0.14.0
   git push origin --delete release/0.14.0
   ```

This creates a normal release with `latest.json`, and all users will be prompted to update.

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes
- **MINOR** (0.X.0): New features, backwards compatible
- **PATCH** (0.0.X): Bug fixes, backwards compatible

Pre-release versions: `0.9.0-beta.1`, `0.9.0-rc.1`

## Related Documentation

- [Auto-Update System](../private/docs/AUTO_UPDATE.md) - Details on the update infrastructure
- [Keep a Changelog](https://keepachangelog.com/) - Changelog format we follow
