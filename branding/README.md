# Branding assets

Everything in this directory is packaging input. It is never written into the harness checkout except the
icon, which `build.ps1` copies to `harness/apps/desktop/build/icon.ico` before packaging.

| File | Required | Effect |
|---|---|---|
| `icon.ico` | no | Application, installer, and uninstaller icon. Without it the stock Electron icon is used. |
| `make-placeholder-icon.ps1` | no | Writes a flat-color placeholder `icon.ico` so a branded build can run before final artwork exists. |

## Icon requirements

electron-builder rejects a Windows icon that has no 256×256 image. Ship a multi-size `.ico` containing at
least 16, 32, 48, 64, 128, and 256 pixel images; a single 256×256 image is accepted but looks soft at small
sizes. PNG-compressed entries are valid.

```powershell
# Generate a throwaway icon, then replace it with real artwork.
./make-placeholder-icon.ps1 -Text DSH
```

`build.ps1` exports the icon path as `DSH_DESKTOP_ICON`, which the branding overlay reads from the packaging
environment. When `branding/icon.ico` is absent the variable is left unset and electron-builder falls back to
its own default resolution.
