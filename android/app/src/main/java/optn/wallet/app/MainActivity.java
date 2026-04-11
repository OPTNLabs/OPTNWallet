package optn.wallet.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import optn.wallet.app.security.DeviceIntegrityPlugin;
import optn.wallet.app.security.ScreenSecurityPlugin;
import optn.wallet.app.security.SecureKeyStorePlugin;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(DeviceIntegrityPlugin.class);
    registerPlugin(ScreenSecurityPlugin.class);
    registerPlugin(SecureKeyStorePlugin.class);
    super.onCreate(savedInstanceState);

    // Keep the WebView inside the system bars instead of drawing underneath them.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    getWindow().setStatusBarColor(Color.BLACK);
    getWindow().setNavigationBarColor(Color.BLACK);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
      Insets insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
      );
      ViewGroup.MarginLayoutParams layoutParams =
        (ViewGroup.MarginLayoutParams) view.getLayoutParams();
      layoutParams.topMargin = insets.top;
      layoutParams.bottomMargin = insets.bottom;
      layoutParams.leftMargin = insets.left;
      layoutParams.rightMargin = insets.right;
      view.setLayoutParams(layoutParams);
      return WindowInsetsCompat.CONSUMED;
    });
    ViewCompat.requestApplyInsets(webView);

    // Disable the AppCompat action bar if one was created
    if (getSupportActionBar() != null) {
      getSupportActionBar().hide();
    }

    // Optional: don’t show a title (prevents faint text in some cases)
    setTitle("");

    // WebView remote debugging only in debug builds.
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
  }
}
