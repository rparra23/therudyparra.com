#!/usr/bin/env bash
# One-shot setup for the deck-gate Worker. Run from cloudflare-worker-deck/:
#   bash setup.sh
# Prompts twice for secrets (DECK_PIN, then TOKEN_SECRET), does the rest itself.
set -euo pipefail
cd "$(dirname "$0")"

SLIDES_DIR="../.deck-slides"
if [ ! -d "$SLIDES_DIR" ]; then
  echo "ERROR: $SLIDES_DIR not found (the local slide backup). Aborting."; exit 1
fi

# 1. Create the KV namespace if the placeholder is still in wrangler.toml
if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "==> Creating KV namespace DECK…"
  OUT=$(npx wrangler kv namespace create DECK 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE 'id = "[a-f0-9]+"' | grep -oE '[a-f0-9]{16,}')
  [ -n "$ID" ] || { echo "Could not parse namespace id from:"; echo "$OUT"; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/" wrangler.toml
  echo "    namespace id: $ID"
else
  ID=$(grep -oE 'id = "[a-f0-9]+"' wrangler.toml | grep -oE '[a-f0-9]{16,}')
  echo "==> Using existing KV namespace: $ID"
fi

# 2. Upload the 35 slides
echo "==> Uploading slides to KV…"
for f in "$SLIDES_DIR"/slide-*.jpg; do
  NN=$(basename "$f" | sed -E 's/slide-([0-9]+)\.jpg/\1/')
  npx wrangler kv key put --remote --namespace-id "$ID" "slide:$NN" --path "$f" >/dev/null
  printf "    slide:%s\n" "$NN"
done

# 3. Secrets — you'll be prompted for each value
echo "==> Set DECK_PIN (enter your PIN, e.g. 7839):"
npx wrangler secret put DECK_PIN
echo "==> Set TOKEN_SECRET (paste the random string below):"
openssl rand -base64 32
npx wrangler secret put TOKEN_SECRET

# 4. Deploy
echo "==> Deploying…"
npx wrangler deploy
echo
echo "Done. The deck gate is live at https://deck.rparra.workers.dev"
echo "Test: open https://therudyparra.com/talks/stem-core/ and enter your PIN."
