# Browz testing and security status

**Correction:** Earlier versions of this report described the automated checks as an independent audit, claimed complete protections and presented a competitive scorecard. Those claims were not substantiated. The tests were authored with the project and many inspect source strings rather than behavior. Passing them is not an independent review, penetration test, certification, or proof of security, anonymity, compatibility or superiority over other browsers.

## Evidence available

- `npm test` runs JavaScript checks, some behavior tests, and many static Android and desktop source assertions. Individual test names and pass messages may overstate their scope.
- GitHub Actions run [40831776617](https://github.com/tarungittarun/Browz/actions/runs/40831776617) passed one Android API 34 emulator smoke test for toolbar visibility, minimum menu height, and opening the menu and tab selector at commit `38cb7c1`. The [Android build](https://github.com/tarungittarun/Browz/actions/runs/40831776694) compiled and checked its signature and manifest. The [automated multi-job workflow](https://github.com/tarungittarun/Browz/actions/runs/40831776719) passed; this is not independent certification or a comprehensive device test.
- These results apply to the tested commit and emulator only; check later workflow runs for changes. No real-device assessment, independent security review, browser compatibility survey, or meaningful anonymity testing has been completed.

## Known security and privacy limitations

- **Android release signing key is compromised.** The key and password were committed. A matching package name does not make a differently signed APK update-compatible. Do not trust newly signed artifacts as security releases; see [mobile notes](MOBILE-PARITY-AND-TESTING.md) for migration concerns.
- Android WebView shares cookies and site storage across tabs; low-cache tabs are not independent accounts or guaranteed private sessions. Request interception and injected scripts are incomplete and do not provide a firewall or full traffic capture. Network profiles do not control Wi-Fi hardware. Browz does not provide Tor or VPN anonymity.
- Native WebView bridges, redirect and frame behavior, local network requests, error handling, permission prompts, and malicious pages need runtime security review. Desktop proxy, Electron isolation, local control plane and download behavior also require review. Source assertions are not proof that controls cannot be bypassed.
- Device administrators, compromised operating systems, input methods and privileged software may access data. Screen protection and clearing data have limitations. See [device and OS guide](SECURITY-AND-OS-ISOLATION.md).

## Next steps

1. Commission an independent audit with an explicit threat model and document findings and retest evidence.
2. Run device and emulator tests across Android/WebView versions, plus real websites, videos, accessibility, slow networks, and attack pages; inspect actual network traffic and site data.
3. Test desktop behavior on installed Windows builds, including untrusted pages, local services, permissions and data persistence.
4. Develop an owner-controlled signing-key rotation and distribution plan before publishing updates; preserve data only where Android's signing rules allow it.
