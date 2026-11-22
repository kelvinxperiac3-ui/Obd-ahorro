package cl.obdahorro.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Mantiene la app funcionando en segundo plano mientras está conectada al adaptador OBD:
 * inicia un servicio en primer plano (notificación fija "OBD Ahorro activo") que retiene
 * la CPU, y opcionalmente mantiene la pantalla encendida.
 */
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = {
        @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifications")
    }
)
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            // La notificación del servicio necesita permiso en Android 13+. Si lo niega, el
            // servicio funciona igual, solo que la notificación no se ve.
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent i = new Intent(getContext(), KeepAliveService.class);
        i.putExtra("title", call.getString("title", "OBD Ahorro activo"));
        i.putExtra("text", call.getString("text", "Leyendo el OBD"));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No pude iniciar el servicio: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (!KeepAliveService.running) { call.resolve(); return; }
        Intent i = new Intent(getContext(), KeepAliveService.class);
        i.setAction(KeepAliveService.ACTION_UPDATE);
        i.putExtra("title", call.getString("title", "OBD Ahorro activo"));
        i.putExtra("text", call.getString("text", ""));
        try {
            getContext().startService(i);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        call.resolve();
    }

    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }
}
