package optn.wallet.app.update;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PlayUpdate")
public class PlayUpdatePlugin extends Plugin {
  @PluginMethod
  public void checkForUpdate(PluginCall call) {
    JSObject result = new JSObject();
    result.put("available", false);
    result.put("updateAvailability", 1);
    result.put("updatePriority", 0);
    result.put("status", 0);
    result.put("stalenessDays", null);
    result.put("isImmediateAllowed", false);
    result.put("isFlexibleAllowed", false);
    result.put("availableVersionCode", 0);
    result.put("isDownloaded", false);
    call.resolve(result);
  }

  @PluginMethod
  public void startFlexibleUpdate(PluginCall call) {
    JSObject result = new JSObject();
    result.put("started", false);
    call.resolve(result);
  }

  @PluginMethod
  public void completeUpdate(PluginCall call) {
    call.resolve();
  }
}
