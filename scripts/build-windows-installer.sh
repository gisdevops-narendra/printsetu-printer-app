#!/bin/sh
# Builds release/installer/PrintSetu-Setup.exe (installer/windows/PrintSetuSetup.iss)
# from the Windows bundle's release/bundle/PrintSetuAgent.exe. The backend
# serves it as the dashboard's "Download for Windows" (GET /api/shop/printers/installer). Uses Inno Setup in Docker, so it works on
# Linux/macOS too; on Windows with Inno Setup installed you can instead run
#   iscc /DBackendHttpUrl=... installer\windows\PrintSetuSetup.iss
#
# The backend address is fixed at build time — it's where the installer sends
# the setup code. Set it for the environment you're building for:
#   PRINTSETU_BACKEND_HTTP_URL=https://api.printsetu.in/api npm run build:installer
set -eu
cd "$(dirname "$0")/.."

if [ ! -f release/bundle/PrintSetuAgent.exe ]; then
  echo 'ERROR: release/bundle/PrintSetuAgent.exe not found. Run "npm run build:exe && npm run package" first.' >&2
  exit 1
fi

BACKEND_URL="${PRINTSETU_BACKEND_HTTP_URL:-}"
if [ -z "$BACKEND_URL" ]; then
  BACKEND_URL=http://localhost:53100/api
  echo "WARNING: PRINTSETU_BACKEND_HTTP_URL not set; the installer will pair against $BACKEND_URL" >&2
fi
# No Node needed (deploy.sh runs this on a Docker-only host).
VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)

# The image compiles as its own user, which can't write into our checkout;
# give it a scratch output folder and copy the result back.
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
chmod 777 "$OUT"
docker run --rm -v "$PWD":/work:ro -v "$OUT":/out -w /work amake/innosetup \
  "/DBackendHttpUrl=$BACKEND_URL" "/DAppVersion=$VERSION" '/OZ:\out' \
  installer/windows/PrintSetuSetup.iss
mkdir -p release/installer
cp "$OUT/PrintSetu-Setup.exe" release/installer/PrintSetu-Setup.exe

echo "Built release/installer/PrintSetu-Setup.exe (pairs against $BACKEND_URL)"
