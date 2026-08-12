package optn.wallet.app.update;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender.SendIntentException;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

@CapacitorPlugin(name = "PlayUpdate")
public class PlayUpdatePlugin extends Plugin {
  private static final int REQUEST_CODE_UPDATE_FLOW = 9137;

  private AppUpdateManager appUpdateManager() {
    return AppUpdateManagerFactory.create(getContext());
  }

  private JSObject toResult(@NonNull AppUpdateInfo info) {
    JSObject result = new JSObject();
    result.put("available", info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE);
    result.put("updateAvailability", info.updateAvailability());
    result.put("updatePriority", info.updatePriority());
    result.put("status", info.installStatus());
    result.put("stalenessDays", info.clientVersionStalenessDays() == null ? null : info.clientVersionStalenessDays());
    result.put("isImmediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE));
    result.put("isFlexibleAllowed", info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE));
    result.put("availableVersionCode", info.availableVersionCode());
    result.put("isDownloaded", info.installStatus() == InstallStatus.DOWNLOADED);
    return result;
  }

  @PluginMethod
  public void checkForUpdate(PluginCall call) {
    Task<AppUpdateInfo> task = appUpdateManager().getAppUpdateInfo();
    task.addOnSuccessListener(info -> call.resolve(toResult(info)));
    task.addOnFailureListener(error -> call.reject("Failed to check for updates", error));
  }

  @PluginMethod
  public void startFlexibleUpdate(PluginCall call) {
    AppUpdateManager manager = appUpdateManager();
    manager.getAppUpdateInfo()
      .addOnSuccessListener(info -> {
        try {
          boolean started = manager.startUpdateFlowForResult(
            info,
            getActivity(),
            AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
            REQUEST_CODE_UPDATE_FLOW
          );
          JSObject result = new JSObject();
          result.put("started", started);
          call.resolve(result);
        } catch (SendIntentException error) {
          call.reject("Failed to start update flow", error);
        }
      })
      .addOnFailureListener(error -> call.reject("Failed to start update flow", error));
  }

  @PluginMethod
  public void completeUpdate(PluginCall call) {
    appUpdateManager()
      .completeUpdate()
      .addOnSuccessListener(ignored -> call.resolve())
      .addOnFailureListener(error -> call.reject("Failed to complete update", error));
  }
}
