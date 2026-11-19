#!/usr/bin/env bash
# Build vektor-mobile for the iOS simulator and assemble
# mobile/target/aarch64-apple-ios-sim/<profile>/bundle/Vektor.app.
# VEKTOR_URL (baked in) picks the server; production when unset.
# Usage: bundle-ios.sh [--release] [extra cargo build args]
set -euo pipefail
cd "$(dirname "$0")/../mobile"

[[ "$(uname)" == "Darwin" ]] || { echo "bundle-ios.sh must run on macOS" >&2; exit 1; }

NAME="Vektor"
IDENTIFIER="de.vektor.app"
TARGET="aarch64-apple-ios-sim"
MIN_IOS="16.0"
VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -1)"
[[ -n "$VERSION" ]] || { echo "no version in mobile/Cargo.toml" >&2; exit 1; }

PROFILE="debug"
[[ "${1:-}" == "--release" ]] && PROFILE="release"

IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS" cargo build --target "$TARGET" "$@"

APP="target/$TARGET/$PROFILE/bundle/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP"
cp "target/$TARGET/$PROFILE/$NAME" "$APP/$NAME"
# The web app's touch icon is full-bleed and opaque, as iOS wants it.
ICON="../../server/public/180x180.png"
cp "$ICON" "$APP/AppIcon60x60@3x.png"
sips -z 120 120 "$ICON" --out "$APP/AppIcon60x60@2x.png" >/dev/null
cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$IDENTIFIER</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleIcons</key>
  <dict>
    <key>CFBundlePrimaryIcon</key>
    <dict>
      <key>CFBundleIconFiles</key><array><string>AppIcon60x60</string></array>
    </dict>
  </dict>
  <!-- The browser hands a sign-in back through this scheme (server/src/components/DesktopLogin.tsx). -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Vektor sign-in</string>
      <key>CFBundleURLSchemes</key><array><string>vektor-desktop</string></array>
    </dict>
  </array>
  <!-- Plain HTTP for a development server (VEKTOR_URL); production is HTTPS. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>Vektor shows the weather for your location on your space's home page.</string>
  <key>MinimumOSVersion</key><string>$MIN_IOS</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UIApplicationSceneManifest</key>
  <dict>
    <key>UIApplicationSupportsMultipleScenes</key><false/>
    <key>UISceneConfigurations</key>
    <dict>
      <key>UIWindowSceneSessionRoleApplication</key>
      <array>
        <dict>
          <key>UISceneConfigurationName</key><string>Default Configuration</string>
          <key>UISceneDelegateClassName</key><string>GPUIIosSceneDelegate</string>
        </dict>
      </array>
    </dict>
  </dict>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
  <key>UISupportedInterfaceOrientations~ipad</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationPortraitUpsideDown</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
</dict>
</plist>
PLIST
plutil -lint "$APP/Info.plist" >/dev/null
codesign --force --sign - "$APP"
echo "$APP"
