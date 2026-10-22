# ⚡ Browz — Multi-Tab Performance Capture & Control Browser

`Browz` is a minimal, high-control browser designed for **100% network request/response capturing, performance testing, isolated multi-account container sessions, and hardware/permission firewall control**.

---

## Key Capabilities

### 1. 100% Network Request & Response Capture + Performance Testing (#2)
* **Captures Everything:** Every page load, `fetch()`, `XMLHttpRequest`, REST call, redirect, and blocked request across all tabs.
* **Deep Inspection:**
  * Full Request URL, Method, Status Code, Remote Address, Protocol, and Container Session.
  * Decoded Query String Parameters, Request Headers, and Response Headers.
  * **Full Request Payload (`postData`)** & **Full Response Body** (pretty-printed JSON/HTML/text).
  * **Sub-Millisecond Timing Breakdown & Waterfall:** Queueing/Blocked, DNS Lookup, TCP Connect, TLS Handshake, Request Send, Server Waiting (**TTFB**), Content Download, and Total Duration.
* **Live Performance Metrics Strip:** Real-time calculation of Total Requests, 2xx Success, 4xx/5xx Error Rate %, Blocked Count, Average Latency, **P50 / P95 / P99 Latency**, Throughput (**req/s**), and Transferred Bytes.
* **One-Click Performance Suite Exports:**
  * **`.HAR` (HTTP Archive 1.2):** Import directly into JMeter, Postman, Insomnia, Gatling, or Chrome DevTools.
  * **Grafana `k6` Script (`.js`):** Auto-generates a ready-to-run `k6` load test script with stages, headers, payloads, and P95/P99 thresholds.
  * **Apache JMeter Test Plan (`.jmx`):** Ready-to-open JMeter XML plan with `ThreadGroup`, `HTTPSamplerProxy`, and `HeaderManager`.
  * **`.CSV` & `.JSON`** reports + **Copy as `cURL`**.
* **Built-in Request Composer & Load Burst Runner:** Replay any captured request, edit its method/URL/headers/body, or fire a concurrent load burst (e.g., 10–50 requests across configurable concurrency) right from the browser.
* **Network Interception Controls:**
  * Network Throttling presets (`No Throttling`, `Fast 4G`, `Slow 3G`, `High Latency WAN`, `Offline Mode`) & `Disable Cache` toggle.
  * Custom Request & Response Header injection, `Bypass CORS`, `Force HTTPS`, `Strip Referer`, `User-Agent` spoofing, URL/Domain/Resource-Type block rules, and Proxy (`HTTP`/`SOCKS5`) configuration.

### 2. Multi-Account Container Sessions & Privacy Isolation (#4)
* **Isolated Container Tabs:** Open any tab in `Default`, `User A (Perf)`, `User B (Perf)`, `Admin Session`, `Burner (RAM Only)`, or create custom containers.
* Each container has its own isolated Cookie Jar and session partition (`persist:<name>` or `ephemeral:<name>`), allowing simultaneous multi-user authentication and load testing side by side.
* **One-Click Storage Wiper:** Wipe cookies, cache, and storage for any container instantly.

### 3. Hardware, Permissions & OS Firewall (#5)
* **Permission Firewall:** Global defaults + per-site overrides (`Allow` / `Deny`) for Camera/Mic (`media`), Geolocation (`geolocation`), Notifications, Clipboard, Popups (`window.open`), MIDI, USB, External OS Protocols, and Fullscreen — with a live intercepted event log.
* **Download Controller:** Intercepts downloads and automatically blocks dangerous file extensions (`.exe`, `.bat`, `.cmd`, `.msi`, `.scr`, `.apk`).

---

## Quick Start

### Run Web / Live Preview Mode
```bash
npm install
npm start
# Opens on http://0.0.0.0:3000
```

### Run Native Desktop Browser (Electron + Chromium CDP)
```bash
npm install
npm install --save-dev electron
npm run desktop
```

### Run Verification Suite
```bash
npm test
```
