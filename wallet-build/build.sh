#!/usr/bin/env bash
# Build a signed .pkpass file from pass.json + assets/ + your Apple Wallet cert.
#
# Inputs (all must be in this directory unless overridden via env vars):
#   pass.json                  — pass metadata
#   assets/icon*.png, logo*.png, thumbnail*.png  — required artwork
#   $CERT_P12      (default: ./cert.p12)        — your Pass Type ID cert + private key, exported from Keychain
#   $CERT_PASSWORD (default: empty)             — passphrase for the .p12
#   $WWDR_PEM      (default: ./wwdr.pem)        — Apple WWDR intermediate cert (G4)
#
# Output: ../wallet/contact.pkpass (in the public site folder so it's served by GitHub Pages)

set -euo pipefail

cd "$(dirname "$0")"

CERT_P12="${CERT_P12:-./cert.p12}"
CERT_PASSWORD="${CERT_PASSWORD:-}"
WWDR_PEM="${WWDR_PEM:-./wwdr.pem}"

OUT_DIR="../wallet"
OUT_FILE="$OUT_DIR/contact.pkpass"

# ---- Preflight ----
[[ -f pass.json ]] || { echo "ERROR: pass.json missing"; exit 1; }
[[ -d assets ]]     || { echo "ERROR: assets/ missing"; exit 1; }
[[ -f "$CERT_P12" ]] || { echo "ERROR: $CERT_P12 not found. See README step 4."; exit 1; }
[[ -f "$WWDR_PEM" ]] || { echo "ERROR: $WWDR_PEM not found. Download from https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer and convert: openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem"; exit 1; }
grep -q "TO_BE_REPLACED_WITH_YOUR_APPLE_TEAM_ID" pass.json && {
  echo "ERROR: edit pass.json and replace TO_BE_REPLACED_WITH_YOUR_APPLE_TEAM_ID with your Apple Team ID (10-char string from developer.apple.com)";
  exit 1;
}

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. Stage files for the pass bundle ----
cp pass.json "$WORK/"
cp assets/*.png "$WORK/"

# ---- 2. Build manifest.json (SHA1 hash per file) ----
python3 - <<PY > "$WORK/manifest.json"
import json, hashlib, os
work = "$WORK"
m = {}
for fn in sorted(os.listdir(work)):
    if fn in ("manifest.json", "signature"): continue
    with open(os.path.join(work, fn), "rb") as f:
        m[fn] = hashlib.sha1(f.read()).hexdigest()
print(json.dumps(m, indent=2))
PY

# ---- 3. Extract cert + key from .p12 into PEM (in-memory) ----
CERT_PEM="$(mktemp)"
KEY_PEM="$(mktemp)"
trap 'rm -f "$CERT_PEM" "$KEY_PEM"; rm -rf "$WORK"' EXIT
openssl pkcs12 -in "$CERT_P12" -clcerts -nokeys -out "$CERT_PEM"  -legacy -passin "pass:$CERT_PASSWORD"
openssl pkcs12 -in "$CERT_P12" -nocerts -nodes  -out "$KEY_PEM"   -legacy -passin "pass:$CERT_PASSWORD"

# ---- 4. Sign manifest.json with PKCS#7 detached signature ----
openssl smime -binary -sign \
  -certfile "$WWDR_PEM" \
  -signer "$CERT_PEM" \
  -inkey "$KEY_PEM" \
  -in "$WORK/manifest.json" \
  -out "$WORK/signature" \
  -outform DER

# ---- 5. Zip everything into .pkpass ----
( cd "$WORK" && zip -q -r "$(cd - >/dev/null; pwd)/$OUT_FILE" . )

echo ""
echo "✓ Built: $(realpath "$OUT_FILE")"
echo ""
echo "Next steps:"
echo "  1. Commit and push the new ../wallet/contact.pkpass"
echo "  2. Edit ../assets/wallet-config.json and set:"
echo "       \"applePkpassUrl\": \"https://therudyparra.com/wallet/contact.pkpass\""
echo "  3. Commit and push wallet-config.json"
echo "  4. Open https://therudyparra.com on an iPhone -> Add to Apple Wallet button should now work"
