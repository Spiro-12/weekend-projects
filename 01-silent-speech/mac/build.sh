#!/bin/bash
# Builds SilentSpeechBridge.app with only the Command Line Tools. No Xcode needed (Xcode is ~15 GB).
# Same settings as project.yml. Signs with "SilentSpeech Local" if that identity exists (see make-cert.sh), else ad hoc.
# Usage: ./build.sh            -> build/Debug/SilentSpeechBridge.app
set -euo pipefail
cd "$(dirname "$0")"

NAME=SilentSpeechBridge
APP="build/Debug/$NAME.app"
ARCH="$(uname -m)"
IDENTITY="${SIGN_IDENTITY:-SilentSpeech Local}"

# /usr/bin/xcrun always exists (a stub), so check for a real toolchain.
xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 || { echo "FAILED: Command Line Tools missing. Run: xcode-select --install"; exit 1; }

rm -rf "$APP" "build/Debug/$NAME.dSYM"
mkdir -p "$APP/Contents/MacOS"

xcrun swiftc -swift-version 5 -parse-as-library -Onone -g \
  -target "$ARCH-apple-macos14.0" -module-name "$NAME" \
  -o "$APP/Contents/MacOS/$NAME" SilentSpeechBridge/*.swift

# Info.plist with the project.yml values filled in.
sed -e "s/\$(EXECUTABLE_NAME)/$NAME/g" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/com.spiro.$NAME/g" \
    -e "s/\$(PRODUCT_NAME)/$NAME/g" \
    -e "s/\$(MARKETING_VERSION)/0.1.0/g" \
    -e "s/\$(CURRENT_PROJECT_VERSION)/1/g" \
    -e "s/\$(MACOSX_DEPLOYMENT_TARGET)/14.0/g" \
    SilentSpeechBridge/Info.plist > "$APP/Contents/Info.plist"
if grep -q '\$(' "$APP/Contents/Info.plist"; then echo "FAILED: unreplaced \$(...) in Info.plist"; exit 1; fi
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Debug symbols must not sit inside the signed bundle.
for d in "$APP"/Contents/MacOS/*.dSYM; do [ -e "$d" ] && mv "$d" build/Debug/; done

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then SIGN="$IDENTITY"; else
  echo "Note: no \"$IDENTITY\" signing identity, signing ad hoc (macOS may re ask for permissions after rebuilds)."; SIGN="-"; fi
codesign --force --sign "$SIGN" --entitlements SilentSpeechBridge/SilentSpeechBridge.entitlements "$APP"
codesign --verify --strict "$APP"
echo "OK: built $APP ($ARCH, signed: $SIGN)"
