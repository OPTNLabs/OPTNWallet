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

# Keep Capacitor runtime/plugin reflection intact.
-keep class com.getcapacitor.** { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class ** {
    @com.getcapacitor.PluginMethod <methods>;
}

# The Capacitor barcode plugin's AAR contains an unused ML Kit backend beside
# ZXing. Wallet calls force ZXing for every Android scan, and build.gradle
# excludes ML Kit and the Play Services barcode artifact from every flavor to
# keep the F-Droid classpath free of proprietary scanner code. R8 still inspects
# the AAR's unreachable ML Kit helper and otherwise fails on these optional
# backend types; allow only the exact missing symbols reported by the release
# build. The release artifact gate separately verifies that scanner binaries
# are not packaged.
-dontwarn com.google.android.gms.tasks.OnFailureListener
-dontwarn com.google.android.gms.tasks.OnSuccessListener
-dontwarn com.google.android.gms.tasks.Task
-dontwarn com.google.mlkit.vision.barcode.BarcodeScanner
-dontwarn com.google.mlkit.vision.barcode.BarcodeScannerOptions
-dontwarn com.google.mlkit.vision.barcode.BarcodeScannerOptions$Builder
-dontwarn com.google.mlkit.vision.barcode.BarcodeScanning
-dontwarn com.google.mlkit.vision.barcode.common.Barcode
-dontwarn com.google.mlkit.vision.common.InputImage

# Remove noisy Android logs from release builds.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
