# Redlynx

A Chromium browser with the things Chrome will not give you, built in rather
than bolted on.

## Download

**[Get the latest release →](https://github.com/Gamer4life36/Redlynx/releases/latest)**

| | |
|---|---|
| **Redlynx-Setup-*.exe** | Installer. Per-user, no admin needed. |
| **Redlynx-Portable-*.exe** | One file, runs without installing. |

Both are self-contained — the ad blocker, yt-dlp, gallery-dl, ffmpeg and the
Tor daemon are all inside. Nothing else to set up.

The binaries live on the releases page rather than in the repository because
they are around 195MB each and git rejects anything over 100MB.

> Windows will say the publisher is unrecognised, because these builds are
> **unsigned on purpose** — a certificate proves who wrote the software, not
> that it is safe, and this is free software. Click **More info → Run anyway**.
> The installer's first page explains it in full.

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
npm run engines:fetch
npm start
```

`engines:fetch` pulls yt-dlp, gallery-dl, ffmpeg and the Tor daemon into
`engines/` — about 250MB, straight from the projects that publish them, and it
verifies Tor's signature on the way past. They are not in git because binaries
that size do not belong there, so a fresh clone needs this once. Redlynx runs
without them; the downloader and the Tor button are simply inert until they
are there.

## Building

```bash
npm run dist
```

Produces an NSIS installer and a portable exe in `dist/`.

Other things worth knowing:

| | |
|---|---|
| `npm test` | the regression suite — real browser, live sites |
| `npm run sources:check` | are the deep-search indexes still answering? |
| `npm run engine:check` | how far behind Chrome this build has drifted |
| `npm run engines:refresh` | pull the newest Electron, test, rebuild |
| `npm run icon` | rebuild the icon set from `branding/redlynx-source.png` |

> **Builds are unsigned, on purpose.** Windows SmartScreen will say the
> publisher is unrecognised — click **More info → Run anyway**. A certificate
> costs a few hundred a year and proves who wrote the software, not that it is
> safe, and this is free software. [SIGNING.md](SIGNING.md) explains the
> trade-off and how to sign it anyway if you ever want to.

## Built with

Electron 43 (Chromium), `@ghostery/adblocker-electron`, `@mozilla/readability`.

## Licence

MIT

## What Redlynx talks to

A browser that quietly phones home is not private, whatever its marketing says,
so here is the complete list. There is no telemetry, no analytics, no crash
reporting and no account. Nothing about what you search or visit leaves the
machine.

**On its own, in the background — one thing only:**

- Ad-blocking filter lists, refreshed every 12 hours from their publishers
  (EasyList, uBlock Origin, AdGuard, Peter Lowe). These are public files
  downloaded the same way by every ad blocker; the request says nothing about
  you. Without refreshing them, blocking decays as sites change. There is a
  "Refresh filter lists" button in Settings if you would rather do it by hand.

**Only when you ask, and only to where you asked:**

- Your searches, to whichever engine you chose.
- Deep search, to the eleven indexes it queries — only when you run one.
- Downloads, to the site you are downloading from.
- The IP check in Anonymity, to `api.ipify.org` — only when you press it.
- DNS-over-HTTPS, to the provider you picked, if you turn it on.
- Tor, when you start it.
- AI, to Anthropic — off by default, and dead code until you both enable it and
  supply your own key. While off, no page content is read and nothing is sent.

**Never:**

- No update check. This is a one-time build with no updater in it at all — the
  code was removed, not disabled.
- No usage statistics, no error reporting, no "anonymous" identifiers.
- No server belonging to Redlynx, because there isn't one.

Verified rather than asserted: left idle for a minute on a blank page, the
browser makes no network requests at all.
