package optn.wallet.app;

import android.os.Bundle;
import android.webkit.WebView; // add
import com.getcapacitor.BridgeActivity;
import androidx.activity.EdgeToEdge;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    EdgeToEdge.enable(this);
    super.onCreate(savedInstanceState);

    // Debugging:
    WebView.setWebContentsDebuggingEnabled(true);
  }
}
