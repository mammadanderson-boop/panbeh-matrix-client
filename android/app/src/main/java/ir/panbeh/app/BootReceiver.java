package ir.panbeh.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Resumes background sync after a reboot or an app update, if the user had it on; drops the installed update's APK. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) PanbehPlugin.updateApk(ctx).delete(); // installed: the downloaded APK is done
        if ((Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) && SyncService.isEnabled(ctx)) {
            SyncService.start(ctx);
        }
    }
}
