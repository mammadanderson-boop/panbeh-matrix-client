package ir.panbeh.app;

import android.content.Context;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;
import com.getcapacitor.CapacitorWebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/** The app's WebView, telling the keyboard it takes images: Gboard then offers a copied image (the pill over the keys,
 *  its clipboard screen) and GIFs/stickers, and hands them to us as content:// URIs. The page gets them as "imeImage". */
public class PanbehWebView extends CapacitorWebView {
    /** The last image's read grant lasts as long as this object: kept until the next one, so the page can read it. */
    private static InputContentInfoCompat last;

    public PanbehWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (ic == null) return null;
        EditorInfoCompat.setContentMimeTypes(outAttrs, new String[] { "image/*" });
        return InputConnectionCompat.createWrapper(ic, outAttrs, (info, flags, opts) -> {
            if (Build.VERSION.SDK_INT >= 25 && (flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    info.requestPermission();
                } catch (RuntimeException e) {
                    return false;
                }
            }
            Uri u = info.getContentUri();
            ContentResolver cr = getContext().getContentResolver();
            String type = cr.getType(u);
            if (type == null || !type.startsWith("image/")) type = info.getDescription().getMimeTypeCount() > 0 ? info.getDescription().getMimeType(0) : "image/png";
            String name = u.getLastPathSegment();
            try (Cursor c = cr.query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
            } catch (RuntimeException e) {
                // no name column: keep the path segment
            }
            if (name == null || name.indexOf('.') < 0) name = "image." + (type.equals("image/jpeg") ? "jpg" : type.substring(6));
            JSArray files = new JSArray();
            files.put(new JSObject().put("uri", u.toString()).put("name", name).put("type", type));
            if (!PanbehPlugin.deliver("imeImage", new JSObject().put("files", files))) {
                info.releasePermission();
                return false;
            }
            if (last != null) last.releasePermission();
            last = info;
            return true;
        });
    }
}
