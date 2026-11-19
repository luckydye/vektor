#!/usr/bin/env bash
# Build vektor-mobile for Android (arm64) and assemble a signed APK at
# mobile/target/aarch64-linux-android/<profile>/bundle/Vektor.apk, without Gradle:
# the app is a NativeActivity subclass (mobile/android) holding the WebView, so
# the SDK build tools compile and package everything directly.
# VEKTOR_URL (baked in) picks the server; production when unset.
# Usage: bundle-android.sh [--release] [extra cargo build args]
set -euo pipefail
cd "$(dirname "$0")/.."

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="$SDK/ndk/$(ls "$SDK/ndk" | sort -V | tail -1)"
BUILD_TOOLS="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM_SDK=36
ANDROID_JAR="$SDK/platforms/android-$PLATFORM_SDK/android.jar"
[[ -f "$ANDROID_JAR" ]] || { echo "missing $ANDROID_JAR (install platform android-$PLATFORM_SDK)" >&2; exit 1; }
# Android 11: the safe area comes from `WindowInsets.getInsets` (API 30).
MIN_SDK=30
API=31

IDENTIFIER="de.vektor.app"
TARGET="aarch64-linux-android"
ABI="arm64-v8a"
VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -1)"
[[ -n "$VERSION" ]] || { echo "no version in mobile/Cargo.toml" >&2; exit 1; }
# Plain HTTP only for a development server.
CLEARTEXT=false
[[ "${VEKTOR_URL:-}" == http://* ]] && CLEARTEXT=true

# javac, d8 and apksigner run on Java: the JDK bundled with Android Studio
# unless JAVA_HOME is set.
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"

PROFILE="debug"
[[ "${1:-}" == "--release" ]] && PROFILE="release"

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$(ls "$NDK/toolchains/llvm/prebuilt" | head -1)"
export CC_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android$API-clang"
export CXX_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android$API-clang++"
export AR_aarch64_linux_android="$TOOLCHAIN/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
cargo build --lib --target "$TARGET" "$@"

OUT="target/$TARGET/$PROFILE/bundle"
WORK="$OUT/work"
rm -rf "$OUT"
mkdir -p "$WORK/res/values" "$WORK/res/mipmap-xxxhdpi" "$WORK/apk/lib/$ABI"

# Native libraries: the app (stripped of its debug info) and the C++ runtime it links.
"$TOOLCHAIN/bin/llvm-strip" --strip-debug "target/$TARGET/$PROFILE/libvektor_mobile.so" \
  -o "$WORK/apk/lib/$ABI/libvektor_mobile.so"
cp "$TOOLCHAIN/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$WORK/apk/lib/$ABI/"

cp ../server/public/192x192.png "$WORK/res/mipmap-xxxhdpi/ic_launcher.png"
# Edge to edge from launch on: GPUI paints behind the transparent system bars.
cat > "$WORK/res/values/styles.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="Vektor" parent="@android:style/Theme.Material.Light.NoActionBar">
    <item name="android:windowBackground">@android:color/white</item>
    <item name="android:statusBarColor">@android:color/transparent</item>
    <item name="android:navigationBarColor">@android:color/transparent</item>
    <item name="android:windowLayoutInDisplayCutoutMode">always</item>
  </style>
</resources>
XML
cat > "$WORK/AndroidManifest.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$IDENTIFIER"
    android:versionCode="1"
    android:versionName="$VERSION">
  <uses-sdk android:minSdkVersion="$MIN_SDK" android:targetSdkVersion="$PLATFORM_SDK" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-feature android:glEsVersion="0x00030000" android:required="true" />
  <!-- Back reaches the WebView as a key event rather than predictive back,
       which would finish the activity. -->
  <application
      android:label="Vektor"
      android:icon="@mipmap/ic_launcher"
      android:extractNativeLibs="true"
      android:theme="@style/Vektor"
      android:usesCleartextTraffic="$CLEARTEXT"
      android:enableOnBackInvokedCallback="false">
    <!-- Every configuration change the app can take without being recreated:
         a recreated activity restarts the app process (see mobile/src/android.rs). -->
    <activity
        android:name="de.vektor.app.VektorActivity"
        android:exported="true"
        android:launchMode="singleTask"
        android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden|keyboard|navigation|uiMode|density|fontScale|fontWeightAdjustment|locale|layoutDirection|colorMode|mcc|mnc|touchscreen|grammaticalGender"
        android:windowSoftInputMode="adjustPan">
      <meta-data android:name="android.app.lib_name" android:value="vektor_mobile" />
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      <!-- The browser hands a sign-in back through this scheme (server/src/components/DesktopLogin.tsx). -->
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="vektor-desktop" android:host="auth" />
      </intent-filter>
    </activity>
  </application>
</manifest>
XML

"$BUILD_TOOLS/aapt2" compile --dir "$WORK/res" -o "$WORK/res.zip"
"$BUILD_TOOLS/aapt2" link -I "$ANDROID_JAR" --manifest "$WORK/AndroidManifest.xml" \
  -o "$WORK/unsigned.apk" "$WORK/res.zip"
# The activity and its WebView → classes.dex.
mkdir -p "$WORK/classes"
"$JAVA_HOME/bin/javac" --release 11 -classpath "$ANDROID_JAR" -d "$WORK/classes" \
  $(find android -name '*.java')
"$BUILD_TOOLS/d8" --min-api "$MIN_SDK" --lib "$ANDROID_JAR" --output "$WORK/apk" \
  $(find "$WORK/classes" -name '*.class')
(cd "$WORK/apk" && zip -qr ../unsigned.apk lib classes.dex)
"$BUILD_TOOLS/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
# Signed with the SDK's debug key (created by Android Studio / the SDK tools).
"$BUILD_TOOLS/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android \
  --ks-key-alias androiddebugkey --key-pass pass:android --v4-signing-enabled false \
  --out "$OUT/Vektor.apk" "$WORK/aligned.apk"
rm -rf "$WORK"
echo "$OUT/Vektor.apk"
