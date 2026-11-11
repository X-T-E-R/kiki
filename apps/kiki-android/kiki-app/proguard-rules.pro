# Preserve WebView JavascriptInterface bridge methods on LegacyJsBridge
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve pluggable KikiToolModule implementations for ServiceLoader discovery
-keep class * implements dev.kiki.android.host.tools.KikiToolModule {
    public <init>();
}

# Protobuf-lite messages inside :core
-keep class * extends com.google.protobuf.GeneratedMessageLite { *; }
-dontwarn java.lang.instrument.**
-dontwarn sun.misc.Unsafe
