#!/usr/bin/env bash
# Gera um QR novo para a instancia Evolution e abre a imagem.
# Uso: scripts/fresh-qr.sh [nome-da-instancia] [--restart]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./apps/api/.env; set +a
INSTANCE="${1:-smoke-test-final}"
if [ "${2:-}" = "--restart" ]; then
  echo "reiniciando socket..."
  curl -s -m 30 -X POST -H "apikey: $EVOLUTION_API_KEY" \
    "$EVOLUTION_API_URL/instance/restart/$INSTANCE" > /dev/null
  sleep 8
fi
OUT="$HOME/Desktop/qr-$(date +%H%M%S).png"
curl -s -m 25 -H "apikey: $EVOLUTION_API_KEY" \
  "$EVOLUTION_API_URL/instance/connect/$INSTANCE" -o .qr-tmp.json
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(".qr-tmp.json","utf8"));
const b64=(j.base64||"").replace(/^data:image\/png;base64,/,"");
if(!b64){console.error("sem QR:",JSON.stringify(j).slice(0,200));process.exit(1);}
fs.writeFileSync(process.argv[1],Buffer.from(b64,"base64"));
console.log("QR gerado | count:",j.count,"| bytes:",Buffer.from(b64,"base64").length);
' "$OUT"
rm -f .qr-tmp.json
WIN="$(cygpath -w "$OUT")"
powershell.exe -NoProfile -Command "Start-Process '$WIN'"
echo "ABERTO: $WIN"
