#!/bin/sh
# Signs a Windows .exe (the Printer App or its installer) with the business's
# code-signing certificate, so Windows shows "Verified publisher" instead of
# "Unknown publisher" and antivirus tools trust it more. Does nothing (and
# succeeds) when no certificate is set up, so builds work without one.
#
#   sh scripts/sign-windows.sh path/to/file.exe
#
# Set ONE of these (deploy.sh reads them from the root .env; GitHub Actions
# from repository secrets — see infra/README.md "Code signing"):
#
#   WINDOWS_SIGN_COMMAND  A command that signs the file given as its last
#                         argument. Use this for certificates kept in a cloud
#                         key service (Azure Trusted Signing, SSL.com eSigner,
#                         Certum SimplySign...), e.g. with jsign:
#                           java -jar /opt/jsign.jar --storetype TRUSTEDSIGNING
#                             --keystore weu.codesigning.azure.net --storepass "$AZ_TOKEN"
#                             --alias <account>/<profile>
#                             --tsaurl http://timestamp.acs.microsoft.com
#
#   WINDOWS_SIGN_PFX      A .pfx/.p12 certificate file (older certificates and
#   WINDOWS_SIGN_PFX_PASSWORD  test certificates), signed with osslsigncode.
#   WINDOWS_SIGN_TIMESTAMP_URL  Time-stamp server (keeps the signature valid
#                         after the certificate expires); default DigiCert's.
#                         Empty: no time-stamp (only for testing).
set -eu

FILE="${1:?usage: sign-windows.sh <file.exe>}"
[ -f "$FILE" ] || { echo "sign-windows.sh: $FILE not found" >&2; exit 1; }

if [ -n "${WINDOWS_SIGN_COMMAND:-}" ]; then
  echo "Signing $FILE (WINDOWS_SIGN_COMMAND)..."
  sh -c "$WINDOWS_SIGN_COMMAND \"\$1\"" sign "$FILE"
elif [ -n "${WINDOWS_SIGN_PFX:-}" ]; then
  [ -f "$WINDOWS_SIGN_PFX" ] || { echo "sign-windows.sh: certificate $WINDOWS_SIGN_PFX not found" >&2; exit 1; }
  echo "Signing $FILE with $(basename "$WINDOWS_SIGN_PFX")..."
  tsa="${WINDOWS_SIGN_TIMESTAMP_URL-http://timestamp.digicert.com}"
  dir="$(cd "$(dirname "$FILE")" && pwd)"
  name="$(basename "$FILE")"
  certdir="$(cd "$(dirname "$WINDOWS_SIGN_PFX")" && pwd)"
  cert="$(basename "$WINDOWS_SIGN_PFX")"
  sign_cmd='osslsigncode sign -pkcs12 "$CERT" -pass "$PFX_PASS" -n "PrintSetu Printer App" -h sha256 ${TSA:+-ts "$TSA"} -in "$IN" -out "$IN.signed"'
  if ! command -v osslsigncode >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then
    # Inside deploy.sh's Debian build container: install it there.
    apt-get update -qq >/dev/null && apt-get install -y -qq osslsigncode >/dev/null 2>&1
  fi
  if command -v osslsigncode >/dev/null 2>&1; then
    CERT="$WINDOWS_SIGN_PFX" PFX_PASS="${WINDOWS_SIGN_PFX_PASSWORD:-}" TSA="$tsa" IN="$FILE" sh -c "$sign_cmd"
  else
    # Not installed here: run it from a throwaway Debian container.
    docker run --rm -v "$dir":/work -v "$certdir":/cert:ro \
      -e CERT="/cert/$cert" -e PFX_PASS="${WINDOWS_SIGN_PFX_PASSWORD:-}" -e TSA="$tsa" -e IN="/work/$name" \
      -e OWNER="$(id -u):$(id -g)" \
      debian:12-slim sh -c "apt-get update -qq >/dev/null && apt-get install -y -qq osslsigncode >/dev/null 2>&1 && $sign_cmd && chown \$OWNER \"\$IN.signed\""
  fi
  mv "$FILE.signed" "$FILE"
  chmod 755 "$FILE"
else
  echo "Not signing $(basename "$FILE"): no code-signing certificate set up (WINDOWS_SIGN_COMMAND or WINDOWS_SIGN_PFX)."
fi
