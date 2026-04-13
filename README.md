# MyTunes

Transfer ringtones to iPhone over USB — no iTunes needed.

![MyTunes Screenshot](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Drag & drop** any audio file — mp3, wav, flac, aac, m4a, mp4, ogg, and more
- **Auto-converts** to proper iPhone ringtone format (44100 Hz AAC with iTunes metadata)
- **Instant recognition** — ringtones appear in Settings immediately, no reboot needed
- **Manage ringtones on device** — browse, play, rename, download, and delete
- **Custom naming** — set the ringtone name before uploading
- **No iTunes, no jailbreak, no developer mode** — works with any iPhone over USB

## Download

Grab the latest release from the [Releases page](https://github.com/Frohrer/mytunes/releases).

- **macOS**: Download the `.dmg` file
- **Windows**: Download the `.exe` installer

## Requirements

- iPhone connected via USB data cable
- "Trust This Computer" accepted on the iPhone (one-time)
- Python 3 with `mutagen` installed (`pip install mutagen`) — used for embedding ringtone metadata

## Usage

1. Connect your iPhone via USB
2. Open MyTunes — your device should appear with a green dot
3. Drop audio files onto the app (or click to browse)
4. Edit the ringtone name if you want
5. Click **Transfer**
6. Your screen will briefly flash black as the ringtone library reloads
7. Go to **Settings > Sounds & Haptics > Ringtone** on your iPhone

### Managing existing ringtones

Click the **On Device** tab to:
- Preview ringtones with the play button
- Select and **Save to Mac** to download them
- Select and **Delete** to remove them
- Double-click a name to **rename** it

## How it works

MyTunes communicates directly with your iPhone over USB using the same protocols as iTunes/Finder:

1. **usbmux** — discovers connected devices
2. **lockdown** — authenticates using the pairing record from "Trust This Computer"
3. **AFC** (Apple File Conduit) — reads/writes files on the device
4. **Ringtones.plist** — registers ringtones with proper GUID, name, and duration
5. **Diagnostics relay** — triggers a sleep/wake cycle to reload the tone library

## Building from source

```bash
# Install dependencies
npm install
pip install mutagen

# Run in development
npm start

# Build for your platform
npm run dist
```

## License

MIT
