# Android 开发环境安装指南

本指南用于配置 Rust + Android SDK，以编译和打包 Yep Anywhere 移动端 App（Tauri v2）。

---

## 1. 安装 Rust

以**管理员身份**打开 PowerShell，执行：

```powershell
# 下载 rustup 安装器
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile rustup-init.exe

# 安装（默认配置，-y 自动确认）
.\rustup-init.exe -y
```

安装完成后，**重启终端**，验证：

```bash
rustc --version
cargo --version
```

### 添加 Android 编译目标

Tauri 需要为 Android 的不同架构编译 Rust 代码：

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

---

## 2. 安装 Android Studio

### 2.1 下载

访问官网下载最新稳定版：

https://developer.android.com/studio

### 2.2 安装选项

运行安装程序，勾选以下组件：

- [x] **Android SDK**
- [x] **Android SDK Platform**
- [x] **Android Virtual Device**（如需使用模拟器）

### 2.3 安装 SDK 组件

打开 Android Studio，点击右上角的 **SDK Manager**（🔧 图标）：

**SDK Platforms 标签页：**

勾选 `Android 16.0 ("Baklava")` —— 对应 API Level 36（本项目 `compileSdk = 36`）。

**SDK Tools 标签页：**

| 组件 | 版本要求 |
|------|---------|
| Android SDK Build-Tools 36 | 36.0.0 |
| NDK (Side by side) | 27.2.12479018 |
| Android SDK Platform-Tools | 最新版 |

点击 **Apply** 下载安装。

> NDK 版本号必须与项目 `ndkVersion` 一致，否则编译会报错。

---

## 3. 配置环境变量

以**管理员身份**打开 PowerShell，执行以下命令：

```powershell
# Android SDK 根目录
[Environment]::SetEnvironmentVariable(
    "ANDROID_HOME",
    "$env:LOCALAPPDATA\Android\Sdk",
    "User"
)

# NDK 目录（版本号要与 SDK Manager 中安装的保持一致）
[Environment]::SetEnvironmentVariable(
    "NDK_HOME",
    "$env:LOCALAPPDATA\Android\Sdk\ndk\27.2.12479018",
    "User"
)
```

Android Studio 安装时会自动把 `platform-tools` 加入 PATH，如果没有：

```powershell
$oldPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
    "Path",
    "$oldPath;%LOCALAPPDATA%\Android\Sdk\platform-tools",
    "User"
)
```

**设置完成后，重启终端。**

---

## 4. 验证安装

重启终端后，依次执行：

```bash
# 验证 Rust
rustc --version
cargo --version

# 验证 Android SDK
adb --version

# 验证环境变量
echo %ANDROID_HOME%
echo %NDK_HOME%
```

如果都有正常输出，说明环境配置成功。

---

## 5. 编译 Yep Anywhere APK

环境就绪后，在项目根目录执行：

```bash
# 进入移动端目录
cd packages/mobile

# 构建前端资源
pnpm prepare-frontend

# 编译 APK
pnpm tauri android build --apk
```

编译成功后，APK 文件位于：

```
packages/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

---

## 6. 常见问题

### 6.1 `cargo` 命令找不到

Rust 安装后未生效。关闭所有终端窗口，重新打开再试。如果仍不行，检查 `C:\Users\<你的用户名>\.cargo\bin` 是否在 PATH 中。

### 6.2 `adb` 命令找不到

Android Studio 可能没有自动添加 PATH。手动添加 `%LOCALAPPDATA%\Android\Sdk\platform-tools` 到系统 PATH。

### 6.3 NDK 版本不匹配

编译时报错 `No version of NDK matched the requested version`。打开 SDK Manager 查看已安装的 NDK 版本号，确保 `NDK_HOME` 环境变量指向正确的版本路径。

### 6.4 缺少 Java

Tauri Android 编译需要 JDK 17+。Android Studio 自带了 JDK，通常会自动使用。如果报错，在 PowerShell 中设置：

```powershell
[Environment]::SetEnvironmentVariable(
    "JAVA_HOME",
    "$env:LOCALAPPDATA\Android\Sdk\jbr",
    "User"
)
```

---

## 7. 替代方案（不装 Android Studio）

如果磁盘空间紧张，可以只安装命令行工具：

```powershell
# 创建目录
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools"

# 下载命令行工具
Invoke-WebRequest `
    -Uri "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip" `
    -OutFile "$env:TEMP\cmdline-tools.zip"

# 解压
Expand-Archive "$env:TEMP\cmdline-tools.zip" -DestinationPath "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools"
Rename-Item "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\cmdline-tools" "latest"

# 安装组件
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" `
    "platform-tools" "platforms;android-36" "ndk;27.2.12479018" "build-tools;36.0.0"
```

> 注意：命令行方案没有 Android Studio 的图形化调试工具，出问题较难排查。
