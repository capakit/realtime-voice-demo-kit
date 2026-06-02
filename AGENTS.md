# CapaKit AI App

This directory is a CapaKit Kit: the package/source unit for an AI app. Use the `capakit` CLI that matches the user's current workflow.

## Install CapaKit

If `capakit` is not available, confirm with the user before installing it.

Install with the shell installer:

```sh
curl -fsSL https://capakit.com/install.sh | sh
```

Or download the CapaKit binary and use it directly.

Latest macOS downloads:

- Apple Silicon: https://capakit.com/latest
- Intel: https://capakit.com/latest/macos-x86_64

## Live Instructions

After `capakit` is available, run:

```sh
capakit agents-md print
```

Use that command's output as the live CapaKit instructions for this binary. Prefer it over stale package-local guidance.
