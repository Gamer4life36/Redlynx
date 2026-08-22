# Redlynx

A Chromium browser with the things Chrome will not give you, built in rather
than bolted on.

## What it does

**Blocks ads properly.** EasyList, EasyPrivacy, uBlock Origin's own filters and
AdGuard, plus uBO's scriptlets injected at document start — which is what
actually stops a YouTube ad, since YouTube serves them from the same domain as
the video. Search-result ads and promoted pins go too.

**Plays video at full quality immediately.** The player is pinned to the best
level a video offers instead of starting low and climbing, without the
rebuffer that forcing it mid-startup causes. Fullscreen is genuinely
fullscreen.

**Downloads media.** yt-dlp, gallery-dl and ffmpeg drive a queue for video,
audio and images from the page you are on.

**Manages tabs like a power user.** Suspend idle tabs, cap CPU, RAM or
bandwidth per tab, see which tab is the pig, drag to reorder, and get every
tab back exactly as it was after a restart.

**Takes privacy as the default.** Encrypted DNS, WebRTC leak blocking, proxy
and Tor routing, third-party cookies off, referrers stripped cross-site, and
per-site permissions that are denied until you say otherwise — then remembered
so you are not asked twice.

**Never saves a password behind your back.** Chrome saves first and tells you
after. Redlynx asks, stores in an encrypted vault, and fills it back only on
the exact site it came from — never inside an embedded frame.

**Fixes sites that made themselves worse.** Google Images expands inline at
full size instead of in a cramped side panel. Google's AI Overview can be
switched off, so results start at the top of the page instead of after a wait.

**Reads.** Reader mode strips a page back to the article using Mozilla's
Readability — the same engine Firefox uses.

**Runs Chrome extensions.** Unpacked extensions load into the browser session.

Ctrl+K opens a command palette for all of it.

## Running from source

```bash
npm install
npm start
```

## Building

```bash
npm run dist
```

Produces an NSIS installer and a portable exe in `dist/`. See
[RELEASING.md](RELEASING.md) for code signing and publishing.

> **Note:** builds are currently unsigned, so Windows SmartScreen will warn
> that the publisher is unrecognised. Click **More info → Run anyway**.
> RELEASING.md covers what signing costs and how to enable it.

## Built with

Electron 43 (Chromium), `@ghostery/adblocker-electron`, `@mozilla/readability`.

## Licence

MIT
