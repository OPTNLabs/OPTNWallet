package optn.wallet.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import optn.wallet.app.security.DeviceIntegrityPlugin;
import optn.wallet.app.security.SecureKeyStorePlugin;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(DeviceIntegrityPlugin.class);
    registerPlugin(SecureKeyStorePlugin.class);
    super.onCreate(savedInstanceState);

    // Disable the AppCompat action bar if one was created
    if (getSupportActionBar() != null) {
      getSupportActionBar().hide();
    }

    // Optional: don’t show a title (prevents faint text in some cases)
    setTitle("");

    // Prevent screenshots/screen recordings for wallet content.
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );

    // WebView remote debugging only in debug builds.
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
  }
}
