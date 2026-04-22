# Push Notifications Troubleshooting

Push notifications allow Yep Anywhere to alert you when a session needs attention, even when the app is in the background or your phone is locked.

## Requirements

Push notifications require:

1. **HTTPS** - Service workers only work over secure connections (or localhost)
2. **Service Worker Support** - Modern browsers (Chrome, Firefox, Safari 16+, Edge)
3. **PushManager API** - Not available in all browsers (notably older Safari versions)
4. **Notification Permission** - User must grant permission when prompted

## Common Issues

### "Push notifications are not supported in this browser"

This can happen for several reasons:

1. **Development Mode** - Service workers are disabled by default in dev mode to avoid page reload issues. Set `VITE_ENABLE_SW=true` in your environment to enable them.

2. **HTTP Connection** - Service workers require HTTPS. Use a reverse proxy with TLS termination.

3. **Unsupported Browser** - Some browsers don't support the Push API:
   - Safari < 16 on iOS
   - Some privacy-focused browsers
   - Browsers in private/incognito mode

4. **Service Worker Blocked by Auth** - If you're using basic auth with a reverse proxy, the service worker file (`sw.js`) must be accessible without authentication. See the Caddy configuration example below.

### Service Worker Registration Fails

Check the browser console for errors. Common causes:

- `sw.js` returns a 401/403 (blocked by auth)
- `sw.js` returns wrong MIME type (must be `application/javascript`)
- Mixed content (loading HTTP resources from HTTPS page)

## Reverse Proxy Configuration

When using a reverse proxy with basic auth, you must exclude PWA files from authentication. The service worker and manifest must be publicly accessible for the browser to register them.

### Caddy Example

```caddyfile
example.com {
    # PWA files must be accessible without auth
    @pwa_public {
        path /manifest.json /sw.js /icon-*.png /favicon.ico /badge-*.png
    }
    handle @pwa_public {
        reverse_proxy 127.0.0.1:3400
    }

    # Everything else requires auth
    handle {
        basicauth {
            username $2a$14$hashedpasswordhere
        }
        reverse_proxy 127.0.0.1:3400
    }
}
```

### nginx Example

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # PWA files - no auth required
    location ~ ^/(manifest\.json|sw\.js|icon-.*\.png|favicon\.ico|badge-.*\.png)$ {
        proxy_pass http://127.0.0.1:3400;
    }

    # Everything else requires auth
    location / {
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3400;
    }
}
```

## Testing Push Notifications

1. Go to **Settings > Notifications** in Yep Anywhere
2. Enable **Push Notifications** (you'll be prompted for permission)
3. Click **Send Test** to verify the notification arrives

If the test notification doesn't appear:

- Check that notifications are enabled in your OS settings
- Check that the browser has notification permission for this site
- Look for errors in the browser console
- Check server logs for push delivery errors

## Still Having Issues?

Open an issue on GitHub with:

- Browser and version
- Operating system
- Any errors from the browser console
- Server logs if available

[Report an Issue](https://github.com/kzahel/yepanywhere/issues)
