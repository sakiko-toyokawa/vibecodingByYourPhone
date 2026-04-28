# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Keep MainActivity.setSystemBars for JNI access from Rust
-keep class com.yepanywhere.mobile.MainActivity {
    public void setSystemBars(boolean);
}

# === Tauri notification plugin ===
# Keep all plugin classes and their fields/methods for JNI and Jackson deserialization
-keep class app.tauri.notification.** { *; }

# Keep @InvokeArg annotated classes (Jackson deserialization depends on field names)
-keepattributes *Annotation*
-keepclassmembers class * {
    @app.tauri.annotation.InvokeArg <fields>;
}

# Keep @Command annotated methods
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}

# Keep BroadcastReceiver subclasses used by the notification plugin
-keep class * extends android.content.BroadcastReceiver {
    <init>(...);
}