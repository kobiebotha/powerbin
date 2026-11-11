package dev.powersync.relay;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import com.longbridge.nsh.NshView;

public final class MainActivity extends Activity {
    static { System.loadLibrary("nsh"); }
    private NshView view;
    private native void initializeKeyring(Context context, String filesDir);

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        initializeKeyring(getApplicationContext(), getFilesDir().getPath());
        view = new NshView(this);
        setContentView(view);
        view.loadAssetBundle("nsh");
    }

    @Override protected void onDestroy() {
        if (view != null) view.destroy();
        super.onDestroy();
    }
}
