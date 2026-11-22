package cl.obdahorro.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
        // Que Android no baje la prioridad de la página cuando la app queda en segundo plano:
        // así la lectura OBD sigue corriendo con la pantalla apagada o usando otra app.
        WebView wv = getBridge().getWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Capacitor no pausa los temporizadores de la página; se reanudan por si acaso.
        getBridge().getWebView().resumeTimers();
    }

    @Override
    public void onStop() {
        super.onStop();
        getBridge().getWebView().resumeTimers();
    }
}
