# Apple Wallet pass — build pipeline

This folder builds the signed `contact.pkpass` file that the "Add to Apple
Wallet" button on therudyparra.com serves. The file is hosted at
`/wallet/contact.pkpass`; iPhone Safari auto-detects the MIME type and shows
the native "Add to Apple Wallet" sheet.

## What you need (one-time)

1. **Apple Developer Program membership** — $99/year
2. A **Mac** (signing happens locally on macOS using openssl + Keychain Access)
3. Your **Apple Team ID** (visible at developer.apple.com → Membership)

## Setup walkthrough

### Step 1. Enroll in the Apple Developer Program (1–2 days)

1. Go to <https://developer.apple.com/programs/enroll/>
2. Sign in with your Apple ID, complete the personal enrollment
3. Pay $99
4. Wait 24–48 hours for approval

### Step 2. Create a Pass Type Identifier (5 min)

1. Sign in to <https://developer.apple.com/account>
2. **Certificates, Identifiers & Profiles → Identifiers**
3. Click **+** → select **Pass Type IDs** → Continue
4. **Description**: `Rudy Parra contact card`
5. **Identifier**: `pass.com.therudyparra.contact`
   (must match `passTypeIdentifier` in `pass.json` — already pre-filled there)
6. Register

### Step 3. Generate a Certificate Signing Request (CSR) on your Mac (5 min)

1. Open **Keychain Access** (search Spotlight)
2. Menu: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
3. **User Email Address**: your Apple Dev email
4. **Common Name**: `Rudy Parra Pass Signing`
5. **CA Email Address**: leave blank
6. Select **Saved to disk** → Continue
7. Save as `CertificateSigningRequest.certSigningRequest` somewhere you can find it

### Step 4. Generate and download the Pass signing certificate (5 min)

1. Back at <https://developer.apple.com/account> → **Identifiers** → click your Pass Type ID
2. **Configure** under "Production Certificate" → **Create Certificate**
3. Upload the `.certSigningRequest` file from Step 3 → Continue
4. **Download** the resulting `pass.cer` file
5. **Double-click** `pass.cer` — Keychain Access opens and imports it
6. In Keychain Access, find the new "Pass Type ID: pass.com.therudyparra.contact" entry
7. **Right-click → Export** → save as `cert.p12` in this folder
   - When prompted, set a passphrase you'll remember (or leave empty)

### Step 5. Get Apple's WWDR intermediate certificate (1 min)

```bash
cd wallet-build
curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
rm AppleWWDRCAG4.cer
```

### Step 6. Fill in your Team ID in pass.json (1 min)

Open `pass.json`, find `"teamIdentifier"`, replace
`TO_BE_REPLACED_WITH_YOUR_APPLE_TEAM_ID` with your actual 10-character Team ID
from developer.apple.com → Membership.

### Step 7. Build the .pkpass

```bash
cd wallet-build
# If you set a passphrase on cert.p12 above:
export CERT_PASSWORD='your-passphrase'

./build.sh
```

The script outputs `../wallet/contact.pkpass`.

### Step 8. Wire the site to your pass

Edit `../assets/wallet-config.json`:

```json
{
  "applePkpassUrl": "https://therudyparra.com/wallet/contact.pkpass",
  "googleWalletJwtUrl": "TO_BE_CONFIGURED"
}
```

Commit and push:
```bash
git add wallet/ assets/wallet-config.json wallet-build/
git commit -m "Wire up Apple Wallet pass"
git push
```

### Step 9. Test on iPhone

Open <https://therudyparra.com> on iPhone Safari → tap **Add to Apple Wallet**.
Pass should preview, tap **Add** → it lives in your Wallet app.

## When you update your contact info

Edit `pass.json` → re-run `./build.sh` → commit the new `wallet/contact.pkpass` →
push. Anyone who already added it will see the update next time their device
syncs (Wallet refreshes passes periodically).

## Security notes

- **Never commit `cert.p12`, `wwdr.pem`, or the CSR file.** The `.gitignore`
  in this folder excludes them.
- Keep your `.p12` somewhere safe (your password manager, encrypted drive).
  If it leaks, anyone can sign passes as you.
- If the cert ever gets compromised, revoke it at developer.apple.com and
  generate a fresh one.

## Troubleshooting

- **"Invalid signature" when opening on iPhone**: most often Team ID mismatch.
  Re-check pass.json's `teamIdentifier`.
- **`openssl pkcs12 ... unsupported`**: macOS ships an old OpenSSL. The script
  already passes `-legacy` to handle this. If still failing, install modern
  OpenSSL via `brew install openssl` and use `/opt/homebrew/bin/openssl`.
- **Pass file builds but iPhone rejects it**: check all required artwork is
  present (we ship icon/logo/thumbnail at 1x/2x/3x). Missing or wrong-sized
  PNGs are the next most common failure mode.
