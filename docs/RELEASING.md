# Publishing a release (auto-update)

SSH Vault updates itself from **GitHub Releases**. Users never need a Telegram
link or a manual download: the app checks for a newer version, downloads it in
the background, and offers a "Restart and install" button. It ships with the
check enabled and users can turn it off in **Settings → Updates**.

## One-time setup

Nothing to configure — `electron-builder.yml` already declares the publish
target:

```yaml
publish:
  provider: github
  owner: mohammadhosseinjafaripour
  repo: SSH-Manager
  releaseType: release
```

`npm run package` bakes that into `resources/app-update.yml` inside the
installed app, so the client knows where to look.

## Cutting a release

1. **Bump the version.** The updater compares semver against the newest
   release, so the number in `package.json` must increase:

   ```bash
   npm version patch    # 0.2.0 -> 0.2.1   (or minor / major)
   ```

2. **Build the artifacts:**

   ```bash
   npm run package
   ```

   This produces in `release/`:

   | File | Purpose |
   | --- | --- |
   | `SSH Vault-<version>-setup.exe` | the installer users run |
   | `SSH Vault-<version>-setup.exe.blockmap` | **required** — enables delta downloads |
   | `latest.yml` | **required** — the manifest the app reads to discover updates |
   | `SSH Vault-<version>-portable.exe` | no-install build (cannot auto-update) |

3. **Create a GitHub Release** tagged exactly `v<version>` (e.g. `v0.2.1`) and
   attach **all four** files above. `latest.yml` and the `.blockmap` are not
   optional: without them the app reports "up to date" forever.

   ```bash
   gh release create v0.2.1 \
     "release/SSH Vault-0.2.1-setup.exe" \
     "release/SSH Vault-0.2.1-setup.exe.blockmap" \
     "release/latest.yml" \
     "release/SSH Vault-0.2.1-portable.exe" \
     --title "SSH Vault 0.2.1" --notes "What changed…"
   ```

   Important: the release must **not** be a draft, and must not be marked
   prerelease (`allowPrerelease` is false).

4. Existing installs pick it up within six hours, or immediately via
   **Settings → Updates → Check now**.

## What the update actually does

- A check is a plain HTTPS GET for the public `latest.yml`. No identifiers, no
  telemetry, nothing about your servers.
- The installer downloads in the background and is verified against the
  `sha512` in `latest.yml`.
- Installing is **never** automatic. `autoInstallOnQuit` is deliberately off:
  quitting on its own would kill live SSH sessions. The user presses
  **Restart and install** when convenient.

## Known limitations

- The **portable** build cannot self-update (there is no installation to
  replace). It shows the update as available and links to the release page.
- The installer is **unsigned**, so Windows SmartScreen warns on first run until
  the project has a code-signing certificate. Auto-updates of an unsigned app
  also work, but signing is recommended before wide distribution.
- Update checks are disabled in a development build (`npm run dev`) — there is
  nothing installed to update.
