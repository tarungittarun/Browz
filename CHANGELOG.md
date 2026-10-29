# Changelog

## 1.0.3 preview (current)

### Added
- **Containers** for separate account spaces; switching closes every page and wipes
  cookies plus site storage.
- **Network rules**: block or allow any domain, with an allow entry overriding the
  built-in tracker list.
- **Real status measuring**: an optional cookie-less HEAD probe for top-level pages,
  shown honestly in the request log.
- **Hardware & permissions** screen: enforced-state report, screenshot protection,
  download policy, sensor/clipboard/file-picker toggles.
- Persistent bookmarks, share, find/zoom/fit-video, new menu.
- CSV request-log export with a real status column.

### Security
- Mixed content is never allowed; an HTTPS page cannot load HTTP subresources.
- Invalid TLS certificates are always cancelled and logged; client-certificate and
  HTTP-auth prompts are refused.
- Network security config: cleartext refused, system trust anchors only.
- WebView remote debugging disabled; external intents restricted to http/https.
- Session cookies and site storage are wiped at launch, so a crash cannot leak a
  previous session into the next run.
- Domain rules reject credentials, scripts, ports and malformed hosts.
- APK Signature Scheme v3 enabled for future key rotation.

### Verification
- New artifact gate (`test/verify-apk.sh`) inspects the signed APK itself.
- New adversarial device suite covering interception, bridge secrets, download
  policy, container and session wiping, capture flags and the injected shield.
- New UX contract suite: 48 dp touch targets, WCAG AA contrast, rotation and start
  budget.
- `THREAT-MODEL.md` documents controls, evidence and residual risk.

## 1.0.0
- First public Windows installer and Android APK. Experimental; Android APK signed
  with a key that was later found to be public.
