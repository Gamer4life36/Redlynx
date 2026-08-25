# Signing Redlynx

Redlynx builds unsigned. Windows shows every user a SmartScreen warning for an
unsigned installer, and many people stop there — so signing is the one step
between "works on my machine" and "someone else will install it".

I can't do this part for you: a certificate is issued to a **verified identity**,
which means a purchase and an ID check in your name.

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
