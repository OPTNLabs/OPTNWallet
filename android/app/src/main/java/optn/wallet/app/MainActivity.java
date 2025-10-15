package optn.wallet.app;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Disable the AppCompat action bar if one was created
    if (getSupportActionBar() != null) {
      getSupportActionBar().hide();
    }

    // Optional: don’t show a title (prevents faint text in some cases)
    setTitle("");

    // WebView remote debugging (dev only)
    WebView.setWebContentsDebuggingEnabled(true);
  }
}
