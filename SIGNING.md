# Signing Redlynx

Redlynx builds unsigned. Windows shows every user a SmartScreen warning for an
unsigned installer, and many people stop there — so signing is the one step
between "works on my machine" and "someone else will install it".

I can't do this part for you: a certificate is issued to a **verified identity**,
which means a purchase and an ID check in your name.

## What you are actually paying for

Not a code review. No certificate authority reads your code or checks it for
malware — they verify **who you are**, then issue a certificate that binds your
name to the signature. The signature proves the installer came from you and has
not been altered. It says nothing about whether the code is any good.

This is why signed malware exists and is common, while a clean unsigned build
gets a scary warning. Windows is measuring accountability, not safety.

The money covers identity verification (documents, callbacks), the hardware
token they post you, and access to a root certificate that Windows already
trusts. That last part is what is genuinely scarce.

## What to buy

Certificate authorities that issue Windows code-signing certificates include
DigiCert, Sectigo, SSL.com and GlobalSign. Two kinds:

| | OV (Organisation Validation) | EV (Extended Validation) |
|---|---|---|
| Cost | roughly $200–400 / year | roughly $300–600 / year |
| Identity check | business or sole-trader documents | stricter, plus notarised documents |
| SmartScreen | reputation builds over time and downloads | trusted immediately |

**Since June 2023 the private key must live on hardware** — a FIPS 140-2 Level 2
USB token the CA ships you, or a cloud HSM (Azure Key Vault, DigiCert KeyLocker,
SSL.com eSigner). You cannot get a plain `.pfx` file to sit on disk any more.
That changes how signing runs, so pick the option that matches your setup:

- **USB token** — signing is interactive; the token's PIN is entered per build
  (or per session, depending on the driver).
- **Cloud HSM** — signing is scriptable and works unattended, which is better if
  you ever build on a schedule.

As an individual rather than a company, ask the CA about an **individual code
signing certificate**; several issue them, with ID verification instead of
business documents.

### The cheap route: Azure Trusted Signing

Microsoft runs its own signing service at roughly **$10/month** rather than
hundreds per year, and it is a real, publicly trusted certificate — not a
workaround. Identity validation still applies, and individuals are eligible.
The key lives in Microsoft's HSM, so there is no USB token to keep track of and
signing can run unattended.

If the only thing standing between this build and other people's machines is
the SmartScreen warning, this is the least painful way through it.

## The free options, and what they cost you instead

**Ship it unsigned.** Users see "Windows protected your PC", click *More info*,
then *Run anyway*. Perfectly workable for yourself and people who already trust
you. Most will not get past it.

**Self-signed certificate.** Free, and makes the binary tamper-evident: you can
tell whether a copy has been modified since you built it. Windows still shows
the same warning to everyone else, because nothing vouches for the certificate.
Useful for your own copies, useless for distribution — unless each person
installs your certificate into their Trusted Root store by hand, which is a
larger ask than clicking through one warning.

**The portable build.** `dist/Redlynx 0.1.0.exe` needs no installer at all. It
still trips SmartScreen on first run, but there is no install step to explain.

## Signing a build

The build is already wired for it — nothing is hardcoded, so no certificate or
password is ever committed.

With a certificate file (older setups, or a cloud provider that gives you one):

```
set CSC_LINK=C:\path\to\certificate.pfx
set CSC_KEY_PASSWORD=your-password
npm run build:signed
```

With a certificate in the Windows certificate store (the usual case for a USB
token), sign by subject name instead:

```
set WIN_CSC_SUBJECT_NAME=Your Name Or Company As It Appears In The Cert
npm run build:signed
```

Then check the result:

```
powershell -Command "Get-AuthenticodeSignature 'dist\Redlynx Setup 0.1.0.exe' | Format-List Status, SignerCertificate"
```

`Status: Valid` means it is done. `NotSigned` means the environment variables
never reached electron-builder.

## What signing does and does not do

It proves the installer came from you and has not been altered since. It does
**not** make the code safe, audited, or approved by anyone — it is an identity
stamp, not a seal of quality. Anyone telling you a signed binary is inherently
trustworthy is selling something.

## Timestamping

electron-builder timestamps signatures by default. This matters: without a
timestamp, the signature stops validating the day the certificate expires, and a
one-time build would go stale in a year. With one, it stays valid indefinitely.
Nothing to configure — just don't disable it.
