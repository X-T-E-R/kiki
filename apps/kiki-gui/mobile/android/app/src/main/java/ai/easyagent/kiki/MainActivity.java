package ai.easyagent.kiki;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(KikiShellPlugin.class);
        super.onCreate(savedInstanceState);
        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("KikiShell");
        if (handle != null && handle.getInstance() instanceof KikiShellPlugin shellPlugin) {
            shellPlugin.ensureWebViewListenersRegistered();
        }
    }
}
