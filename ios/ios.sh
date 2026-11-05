#!/bin/bash
# ios.sh: builds UniiChat for iOS, on a Mac with Xcode and xcodegen (CI:
# .github/workflows/ios.yml, on GitHub's macOS runners).
#
#   ios.sh shots <dir>   a simulator build, run on the App Store's two
#                        screen sizes; screenshots of its first 10 s
#                        (the intro, then the hello), each half second,
#                        go to <dir>
#   ios.sh testflight    an archive signed for the team, uploaded to App
#                        Store Connect (TestFlight), numbered $BUILD
#
# testflight reads TEAM_ID, and the team's App Store Connect API key
# (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY: the .p8's text), which also lets
# Xcode make the certificate, the bundle ids and the profiles it needs.
set -euo pipefail
cd "$(dirname "$0")"
xcodegen generate --quiet

case "$1" in
  shots)
    mkdir -p "$2"
    xcodebuild -quiet -project UniiChat.xcodeproj -scheme UniiChat -sdk iphonesimulator \
      -destination "generic/platform=iOS Simulator" -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
    for name in "iPhone 17 Pro Max" "iPad Pro 13-inch (M5)"; do
      dev=$(xcrun simctl list devices available | grep -F "$name (" | head -1 | grep -oE '[0-9A-F-]{36}')
      xcrun simctl boot "$dev"
      xcrun simctl bootstatus "$dev" > /dev/null
      xcrun simctl status_bar "$dev" override --time 9:41 --batteryState charged --batteryLevel 100
      xcrun simctl install "$dev" build/Build/Products/Debug-iphonesimulator/UniiChat.app
      xcrun simctl launch "$dev" com.raymondwko.everchat
      for t in $(seq 1 20); do
        sleep 0.5
        xcrun simctl io "$dev" screenshot "$2/${name// /_}-$t.png" > /dev/null
      done
      xcrun simctl shutdown "$dev"
    done
    ;;
  testflight)
    key="$(mktemp -d)/AuthKey_$ASC_KEY_ID.p8"
    printf '%s\n' "$ASC_KEY" > "$key"
    auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    xcodebuild -quiet -project UniiChat.xcodeproj -scheme UniiChat -destination generic/platform=iOS \
      -archivePath build/UniiChat.xcarchive DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" "${auth[@]}" archive
    cat > build/export.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
EOF
    xcodebuild -quiet -exportArchive -archivePath build/UniiChat.xcarchive -exportOptionsPlist build/export.plist \
      -exportPath build/export "${auth[@]}"
    ;;
esac
