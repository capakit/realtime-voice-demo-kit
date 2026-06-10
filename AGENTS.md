# CapaKit AI App

This directory is a CapaKit Kit: the package/source unit for an AI app. Use the `capakit` CLI that matches the user's current workflow.

## Install CapaKit

If `capakit` is not available, confirm with the user before installing it.

Install with the shell installer:

```sh
curl -fsSL https://capakit.com/install.sh | sh
```

CapaKit macOS releases are signed and notarized. The installer verifies the downloaded `capakit`
binary's CapaKit Developer ID signature before installing it.

Or install with Homebrew:

```sh
brew install capakit/tap/capakit
```

Manual release archives and checksums are available from https://github.com/capakit/cli/releases.

## Live Instructions

After `capakit` is available, run:

```sh
capakit agents-md print
```

Use that command's output as the live CapaKit instructions for this binary. Prefer it over stale package-local guidance.
