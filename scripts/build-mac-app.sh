#!/usr/bin/env bash
set -e

# 경로 설정
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

echo "🦀 1. Rust 네이티브 데스크톱 바이너리 릴리즈 빌드..."
cd "$DIR/apps/desktop"
cargo build --release

echo "📦 2. Hanul.app 번들 디렉토리 구조 생성..."
APP_BUNDLE="$DIR/dist/Hanul.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources/vendor"
mkdir -p "$APP_BUNDLE/Contents/Resources/media"

echo "🚀 3. 바이너리 복사..."
cp "$DIR/apps/desktop/target/release/hanul-desktop" "$APP_BUNDLE/Contents/MacOS/Hanul"
chmod +x "$APP_BUNDLE/Contents/MacOS/Hanul"

echo "🎨 4. 앱 아이콘(.icns) 생성 및 배치..."
ICONSET_TMP="/tmp/hanul_icons.iconset"
rm -rf "$ICONSET_TMP"
mkdir -p "$ICONSET_TMP"
sips -z 16 16     "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_16x16.png" > /dev/null 2>&1
sips -z 32 32     "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_16x16@2x.png" > /dev/null 2>&1
sips -z 32 32     "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_32x32.png" > /dev/null 2>&1
sips -z 64 64     "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_32x32@2x.png" > /dev/null 2>&1
sips -z 128 128   "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_128x128.png" > /dev/null 2>&1
sips -z 256 256   "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_128x128@2x.png" > /dev/null 2>&1
sips -z 256 256   "$DIR/docs/assets/icon.png" --out "$ICONSET_TMP/icon_256x256.png" > /dev/null 2>&1
iconutil -c icns "$ICONSET_TMP" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET_TMP"

echo "📄 5. 웹 런타임 및 에셋 복사..."
cp -R "$DIR/vendor/studio" "$APP_BUNDLE/Contents/Resources/vendor/"
cp -R "$DIR/media/"* "$APP_BUNDLE/Contents/Resources/media/"

echo "⚙️ 6. Info.plist 생성..."
cat << 'EOF' > "$APP_BUNDLE/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>한울</string>
    <key>CFBundleDisplayName</key>
    <string>한울</string>
    <key>CFBundleIdentifier</key>
    <string>com.kodingko.hanul</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleExecutable</key>
    <string>Hanul</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>한글 표준 문서 (HWPX)</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>hwpx</string>
            </array>
            <key>LSHandlerRank</key>
            <string>Owner</string>
        </dict>
        <dict>
            <key>CFBundleTypeName</key>
            <string>한글 바이너리 문서 (HWP)</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>hwp</string>
            </array>
            <key>LSHandlerRank</key>
            <string>Default</string>
        </dict>
    </array>
</dict>
</plist>
EOF

echo "✨ Hanul.app 빌드 완료: $APP_BUNDLE"
ls -lh "$APP_BUNDLE/Contents/MacOS/Hanul"
