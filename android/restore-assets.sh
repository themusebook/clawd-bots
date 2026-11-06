#!/bin/sh
# Restores the PNG assets from their .b64 sidecars (they crossed as text),
# then removes the sidecars. Run once from anywhere: sh restore-assets.sh
set -e
cd "$(dirname "$0")"
for b64 in assets/images/*.b64 og-image.png.b64; do
  [ -f "$b64" ] || continue
  out="${b64%.b64}"
  base64 -D -i "$b64" -o "$out"
  rm "$b64"
  echo "restored $out"
done
echo "Done. Now: npm install && npx tsc --noEmit && npm test"
