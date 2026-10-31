#!/bin/bash
# Makes the "SilentSpeech Local" code signing identity in the login keychain (SETUP.md step 1).
# With a stable identity macOS keeps the Motion / Automation permissions across rebuilds.
# Safe to run again: a valid identity is kept; stale or broken copies are deleted and remade.
# Popups for Spiro: (1) his Mac password to trust the certificate (only when it is new),
# (2) the test signature at the end: "codesign wants to sign using key ...": password + "Always Allow".
set -eu

NAME="SilentSpeech Local"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
DIR="$HOME/.silentspeech/cert"

valid_count() {
  # Number of valid (trusted) code signing identities with exactly this name.
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -c "\"$NAME\"" || true
}

if [ "$(valid_count)" = "1" ]; then
  echo "OK: \"$NAME\" already exists and is valid."
else
  # Delete every old copy (certificate + its private key) so codesign never sees two or a broken one.
  HASHES=$(security find-certificate -a -c "$NAME" -Z "$KEYCHAIN" 2>/dev/null | awk '/SHA-1 hash:/ {print $3}' || true)
  for H in $HASHES; do
    echo "Deleting old \"$NAME\" certificate $H"
    security delete-identity -Z "$H" "$KEYCHAIN" >/dev/null 2>&1 \
      || security delete-certificate -Z "$H" "$KEYCHAIN" >/dev/null 2>&1 \
      || true
  done

  mkdir -p "$DIR"
  chmod 700 "$DIR"
  cd "$DIR"
  rm -f key.pem local.p12 cert.pem cert.cnf
  trap 'rm -f "$DIR/key.pem" "$DIR/local.p12"' EXIT

  printf '%s\n' \
    '[ req ]' \
    'distinguished_name = dn' \
    'x509_extensions = ext' \
    'prompt = no' \
    '[ dn ]' \
    "CN = $NAME" \
    '[ ext ]' \
    'basicConstraints = critical, CA:false' \
    'keyUsage = critical, digitalSignature' \
    'extendedKeyUsage = critical, codeSigning' > cert.cnf

  # /usr/bin/openssl is LibreSSL: its .p12 is one `security import` accepts (a Homebrew OpenSSL 3 one is not).
  PASS=$(/usr/bin/openssl rand -hex 16)
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config cert.cnf -keyout key.pem -out cert.pem
  /usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "$NAME" -out local.p12 -passout "pass:$PASS"
  security import local.p12 -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
  rm -f key.pem local.p12 # the private key now lives only in the keychain

  echo "macOS now asks for the Mac password to trust the certificate for code signing."
  if ! security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" cert.pem; then
    echo "FAILED: the certificate was not trusted (password box cancelled?). Run this script again." >&2
    exit 1
  fi

  if [ "$(valid_count)" != "1" ]; then
    echo "FAILED: \"$NAME\" is not a valid code signing identity. Run this script again." >&2
    security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME" >&2 || true
    exit 1
  fi
  echo "OK: made \"$NAME\"."
fi

# Test signature now, so the keychain popup shows up while Spiro is at the keyboard (not during a build).
echo "Test signing: if a popup asks, type the Mac password and click Always Allow."
TEST=/tmp/ss-sign-test
cp /usr/bin/true "$TEST"
if OUT=$(codesign -f -s "$NAME" "$TEST" 2>&1); then
  rm -f "$TEST"
  echo "OK: signing works."
else
  rm -f "$TEST"
  echo "$OUT" >&2
  echo "FAILED: test signature. If the popup was answered with Deny, run this script again and click Always Allow." >&2
  exit 1
fi
