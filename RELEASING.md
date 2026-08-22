# Releasing Redlynx

Two things stand between a local build and something other people can install
without a scary dialog: a **code signing certificate** and a **published
release** for the updater to read. They are independent — you can publish
unsigned today and add signing later.

---

## 1. Code signing

### Why it matters

An unsigned installer triggers Windows SmartScreen: *"Windows protected your
PC — unrecognised app"*. The user has to click **More info → Run anyway**.
Most people don't, and never tell you why.

Signing also matters for updates. `electron-updater` verifies the signature of
a downloaded update on Windows before applying it. While the app is unsigned
that check would fail every time, so `verifyUpdateCodeSignature` is currently
`false` in `package.json`. **Turn it back to `true` the moment you sign** —
leaving it off means an attacker who could tamper with the update feed could
hand you a modified binary.

### What it costs

A certificate cannot be self-issued for this purpose. Self-signed certificates
do nothing for SmartScreen — Windows only trusts certificates chaining to a
recognised CA. Since June 2023 all code-signing private keys must live on a
hardware token or in a cloud HSM, which is why there is no free option.

| Route | Rough cost | Notes |
|---|---|---|
| **Azure Trusted Signing** | ~$10/month | Cheapest legitimate path. Needs an Azure subscription and identity verification. Individual (non-company) accounts need a verifiable history — check current eligibility before paying. |
| **OV certificate** (Sectigo, DigiCert…) | ~$200–400/year | Ships on a hardware token. SmartScreen reputation still has to build up over downloads. |
| **EV certificate** | ~$400–700/year | Hardware token. Carries SmartScreen reputation immediately, which is the real reason people pay the difference. |

### Once you have one

`electron-builder` picks up a certificate from the environment — no config
change needed:

```bash
export CSC_LINK="C:/path/to/certificate.pfx"
export CSC_KEY_PASSWORD="the password"
npm run dist
```

For Azure Trusted Signing, set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
`AZURE_CLIENT_SECRET` and add an `azureSignOptions` block to `build.win` in
`package.json` (see the electron-builder docs — the field names change between
majors, so copy them from the version you have installed).

Verify afterwards:

```bash
powershell -Command "Get-AuthenticodeSignature 'dist/Redlynx Setup 0.1.0.exe' | Format-List Status, SignerCertificate"
```

`Status` should read `Valid`.

### Until then

The SmartScreen warning is expected, not a bug. If you share the installer,
tell people plainly: *"Windows will warn that the publisher is unrecognised —
click More info, then Run anyway."* Pretending it won't happen is how you lose
trust the first time it does.

---

## 2. Publishing a release

The updater in `src/updater.js` reads GitHub releases for the repo named in
`build.publish` (currently `Gamer4life36/Redlynx`). Until a release exists
there, every update check correctly reports "up to date" — there is genuinely
nothing newer to find.

### First time

```bash
gh auth login
gh repo create Gamer4life36/Redlynx --public --source=. --remote=origin --push
```

### Each release

Bump the version first — the updater compares against `package.json`:

```bash
npm version patch          # or minor / major
```

Then build and publish in one step. `GH_TOKEN` must be set, or `gh auth login`
must already have run:

```bash
npm run dist:publish
```

That uploads the installer, the portable exe, and `latest.yml` — the manifest
the updater actually reads. **A release without `latest.yml` is invisible to
the updater**, which is the usual reason a "published" update never appears.

### Checking it worked

Install the previous version, then open **Settings → Updates → Check for
updates**. It should offer the new version, download on consent, and install
on quit.

---

## Notes

- Commit authorship is set to `Gamer4life36@users.noreply.github.com` so
  publishing does not expose a personal email address. Keep it that way:
  `git config user.email` is already set in this clone.
- `dist/` and `node_modules/` are gitignored. The repo holds source only.
- The AI assistant's API key is a user preference stored outside the repo and
  defaults to empty — nothing to leak by publishing.
