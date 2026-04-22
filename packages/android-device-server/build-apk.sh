#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

./gradlew --no-daemon :app:assembleRelease

src="app/build/outputs/apk/release/app-release-unsigned.apk"
dst="app/build/outputs/apk/release/yep-device-server.apk"

cp "$src" "$dst"
echo "$dst"
