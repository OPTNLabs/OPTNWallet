package optn.wallet.app.security;

import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

@CapacitorPlugin(name = "DeviceIntegrity")
public class DeviceIntegrityPlugin extends Plugin {
  private static final String[] ROOT_PATHS = new String[] {
    "/system/app/Superuser.apk",
    "/sbin/su",
    "/system/bin/su",
    "/system/xbin/su",
    "/data/local/xbin/su",
    "/data/local/bin/su",
    "/system/sd/xbin/su",
    "/system/bin/failsafe/su",
    "/data/local/su"
  };

  private boolean isLikelyRooted() {
    if (Build.TAGS != null && Build.TAGS.contains("test-keys")) {
      return true;
    }
    for (String path : ROOT_PATHS) {
      if (new File(path).exists()) {
        return true;
      }
    }
    return false;
  }

  private boolean isDebuggerAttachedOrDebugBuild() {
    final boolean debugFlag = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    return debugFlag || android.os.Debug.isDebuggerConnected();
  }

  private boolean isAdbEnabled() {
    try {
      return Settings.Global.getInt(
        getContext().getContentResolver(),
        Settings.Global.ADB_ENABLED,
        0
      ) == 1;
    } catch (Exception ignored) {
      return false;
    }
  }

  private boolean isLikelyEmulator() {
    return (Build.FINGERPRINT != null && Build.FINGERPRINT.startsWith("generic"))
      || (Build.MODEL != null && (
        Build.MODEL.contains("google_sdk")
          || Build.MODEL.contains("Emulator")
          || Build.MODEL.contains("Android SDK built for x86")
      ))
      || (Build.MANUFACTURER != null && Build.MANUFACTURER.contains("Genymotion"))
      || (Build.BRAND != null && Build.DEVICE != null && Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic"))
      || "google_sdk".equals(Build.PRODUCT);
  }

  @PluginMethod
  public void assess(PluginCall call) {
    JSArray reasons = new JSArray();

    if (isLikelyRooted()) reasons.put("root_detected");
    if (isDebuggerAttachedOrDebugBuild()) reasons.put("debugger_or_debuggable");
    if (isAdbEnabled()) reasons.put("adb_enabled");
    if (isLikelyEmulator()) reasons.put("emulator_detected");

    JSObject ret = new JSObject();
    ret.put("compromised", reasons.length() > 0);
    ret.put("reasons", reasons);
    call.resolve(ret);
  }
}
