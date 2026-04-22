# Android Device Server (Prototype)

This package builds `yep-device-server.apk`, a tiny Android process launched via `app_process`.

## Toolchain

- JDK 17
- Android Gradle Plugin 8.11.0
- Gradle 8.14.3
- compileSdk/targetSdk 36, minSdk 24

## Build

```bash
cd packages/android-device-server
./build-apk.sh
```

Output APK:

`app/build/outputs/apk/release/yep-device-server.apk`

## Manual Device Launch

```bash
adb -s <serial> push app/build/outputs/apk/release/yep-device-server.apk /data/local/tmp/yep-device-server.apk
adb -s <serial> shell CLASSPATH=/data/local/tmp/yep-device-server.apk app_process /system/bin com.yepanywhere.DeviceServer
adb -s <serial> forward tcp:27183 tcp:27183
```

## Emulator Override (APK path testing)

To force emulator sessions to use the APK transport instead of emulator gRPC:

```bash
export DEVICE_BRIDGE_USE_APK_FOR_EMULATOR=true
```

The bridge will route `emulator-*` IDs through `AndroidDevice` (APK path).  
You can also force a specific ID explicitly with `android:<serial>` (for example, `android:emulator-5554`).

Run the dedicated E2E variant from repo root:

```bash
pnpm test:e2e:emulator:apk
```

## Wire Protocol

- Handshake (device -> sidecar): `[width u16 LE][height u16 LE]`
- Frame request (sidecar -> device): `[0x01]`
- Frame response (device -> sidecar): `[0x02][len u32 LE][JPEG bytes]`
- Control command (sidecar -> device): `[0x03][len u32 LE][JSON bytes]`

Control JSON examples:

- `{"cmd":"touch","touches":[{"x":0.5,"y":0.3,"pressure":1.0}]}`
- `{"cmd":"key","key":"back"}`
- `{"cmd":"capture_settings","maxWidth":360}` (0 or missing = native width)
