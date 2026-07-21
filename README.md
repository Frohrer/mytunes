# Tonedrop

Transfer ringtones to iPhone over USB — no iTunes needed.

![Platform](https://img.shields.io/badge/platform-macOS-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Drag & drop** any audio file — mp3, wav, flac, aac, m4a, mp4, ogg, and more
- **Auto-converts** to proper iPhone ringtone format (44100 Hz AAC with iTunes metadata)
- **Properly registered** — writes a real `Ringtones.plist` entry (GUID, name, duration), so iOS lists the tone under its own name rather than as a raw filename
- **Manage ringtones on device** — browse, play, rename, download, and delete
- **Custom naming** — set the ringtone name before uploading
- **No iTunes, no jailbreak, no developer mode** — works with any iPhone over USB

## Download

Grab the latest release from the [Releases page](https://github.com/Frohrer/tonedrop/releases).

- **macOS**: Download the `.dmg` file

> **Platform support.** Released builds target macOS. The device transport
> already speaks usbmux on both platforms (`/var/run/usbmuxd` on macOS, TCP
> 27015 on Windows, which Apple Mobile Device Support provides). The remaining
> gap is audio conversion: it shells out to macOS's `afconvert`/`afinfo`, so a
> Windows build needs a bundled encoder. Tracked in
> [issue #1](https://github.com/Frohrer/tonedrop/issues/1).

## Requirements

- macOS (Windows planned — see above)
- iPhone connected via USB data cable
- "Trust This Computer" accepted on the iPhone (one-time)

## Usage

1. Connect your iPhone via USB
2. Open Tonedrop — your device should appear with a green dot
3. Drop audio files onto the app (or click to browse)
4. Edit the ringtone name if you want
5. Click **Transfer**
6. Click **Restart iPhone** when prompted — iOS requires a reboot to load new ringtones
7. After restart, go to **Settings > Sounds & Haptics > Ringtone** on your iPhone

### Managing existing ringtones

Click the **On Device** tab to:
- Preview ringtones with the play button
- Select and **Save to Mac** to download them
- Select and **Delete** to remove them
- Double-click a name to **rename** it

## How it works

Tonedrop communicates directly with your iPhone over USB using the same protocols as iTunes/Finder:

1. **usbmux** — discovers connected devices
2. **lockdown** — authenticates using the pairing record from "Trust This Computer"
3. **AFC** (Apple File Conduit) — reads/writes files on the device
4. **Ringtones.plist** — registers ringtones with proper GUID, name, and duration
5. **Diagnostics relay** — restarts the device to load new ringtones

## Building from source

```bash
npm install
npm start

# Run tests
npm test

# Build a macOS app
npm run dist:mac
```

## Releasing (maintainers)

Pushing a `v*` tag triggers the GitHub Actions release workflow. For a
distributable build that opens without Gatekeeper warnings, the app must be
signed with an Apple Developer ID and notarized. Configure these repository
secrets:

| Secret | Description |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate |
| `CSC_KEY_PASSWORD` | Password for the `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

When these are present the workflow signs and notarizes automatically. Without
them it still produces an **unsigned** build (for local testing only) — such
builds are blocked by Gatekeeper and should not be distributed.

## License

MIT — see [LICENSE](LICENSE).
