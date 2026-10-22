'use strict';

function percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1));
  return Number(sortedNums[idx].toFixed(2));
}

function computeMetrics(entries) {
  const total = entries.length;
  if (total === 0) {
    return {
      total: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      blocked: 0,
      errorRate: 0,
      totalBytes: 0,
      avgDurationMs: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      rps: 0,
      byType: {},
      slowest: []
    };
  }

  let status2xx = 0;
  let status3xx = 0;
  let status4xx = 0;
  let status5xx = 0;
  let blocked = 0;
  let totalBytes = 0;
  const durations = [];
  const byType = {};
  let minStart = Infinity;
  let maxEnd = 0;

  for (const e of entries) {
    const type = e.resourceType || 'Other';
    byType[type] = (byType[type] || 0) + 1;

    if (e.blocked || e.status === 0) {
      blocked++;
    } else if (e.status >= 200 && e.status < 300) {
      status2xx++;
    } else if (e.status >= 300 && e.status < 400) {
      status3xx++;
    } else if (e.status >= 400 && e.status < 500) {
      status4xx++;
    } else if (e.status >= 500) {
      status5xx++;
    }

    totalBytes += Number(e.transferSize || e.responseBodySize || 0);
    const dur = Number(e.timings?.total || 0);
    if (!e.blocked && dur >= 0) {
      durations.push(dur);
    }

    const st = Number(e.startTimeMs || Date.now());
    if (st < minStart) minStart = st;
    if (st + dur > maxEnd) maxEnd = st + dur;
  }

  durations.sort((a, b) => a - b);
  const sumDur = durations.reduce((acc, v) => acc + v, 0);
  const avgDurationMs = durations.length ? Number((sumDur / durations.length).toFixed(2)) : 0;
  const minDurationMs = durations.length ? Number(durations[0].toFixed(2)) : 0;
  const maxDurationMs = durations.length ? Number(durations[durations.length - 1].toFixed(2)) : 0;

  const spanSec = Math.max(1, (maxEnd - minStart) / 1000);
  const rps = Number((total / spanSec).toFixed(2));
  const errors = status4xx + status5xx;
  const errorRate = Number(((errors / total) * 100).toFixed(1));

  const slowest = [...entries]
    .filter((e) => !e.blocked)
    .sort((a, b) => (b.timings?.total || 0) - (a.timings?.total || 0))
    .slice(0, 5)
    .map((e) => ({
      id: e.id,
      method: e.method,
      url: e.url,
      status: e.status,
      totalMs: Number((e.timings?.total || 0).toFixed(1))
    }));

  return {
    total,
    status2xx,
    status3xx,
    status4xx,
    status5xx,
    blocked,
    errorRate,
    totalBytes,
    avgDurationMs,
    minDurationMs,
    maxDurationMs,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    rps,
    byType,
    slowest
  };
}

function objectToHeaderList(hdrObj) {
  if (!hdrObj) return [];
  if (Array.isArray(hdrObj)) return hdrObj;
  return Object.entries(hdrObj).map(([name, value]) => ({
    name: String(name),
    value: Array.isArray(value) ? value.join('; ') : String(value ?? '')
  }));
}

function toHAR(entries) {
  const harEntries = entries.map((e) => {
    const reqHeaders = objectToHeaderList(e.requestHeaders);
    const resHeaders = objectToHeaderList(e.responseHeaders);
    const timings = e.timings || {};

    return {
      startedDateTime: e.startedDateTime || new Date(e.startTimeMs || Date.now()).toISOString(),
      time: Number((timings.total || 0).toFixed(2)),
      _tabId: e.tabId || 'tab-1',
      _containerId: e.containerId || 'default',
      _resourceType: e.resourceType || 'Other',
      request: {
        method: e.method || 'GET',
        url: e.url || '',
        httpVersion: e.protocol || 'HTTP/1.1',
        cookies: e.requestCookies || [],
        headers: reqHeaders,
        queryString: e.queryString || [],
        postData: e.requestBody
          ? {
              mimeType:
                (e.requestHeaders && (e.requestHeaders['content-type'] || e.requestHeaders['Content-Type'])) ||
                'application/json',
              text: String(e.requestBody)
            }
          : undefined,
        headersSize: -1,
        bodySize: e.requestBodySize || (e.requestBody ? Buffer.byteLength(String(e.requestBody)) : 0)
      },
      response: {
        status: e.status || 0,
        statusText: e.statusText || (e.blocked ? 'Blocked' : 'OK'),
        httpVersion: e.protocol || 'HTTP/1.1',
        cookies: e.responseCookies || [],
        headers: resHeaders,
        content: {
          size: e.responseBodySize || 0,
          compression: 0,
          mimeType: e.mimeType || 'text/plain',
          text: e.responseBody || ''
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: e.transferSize || e.responseBodySize || 0
      },
      cache: {},
      timings: {
        blocked: Number((timings.blocked ?? 0).toFixed(2)),
        dns: Number((timings.dns ?? 0).toFixed(2)),
        connect: Number((timings.connect ?? 0).toFixed(2)),
        ssl: Number((timings.ssl ?? 0).toFixed(2)),
        send: Number((timings.send ?? 0.5).toFixed(2)),
        wait: Number((timings.wait ?? 0).toFixed(2)),
        receive: Number((timings.receive ?? 0).toFixed(2))
      },
      serverIPAddress: e.remoteAddress || '127.0.0.1'
    };
  });

  return JSON.stringify(
    {
      log: {
        version: '1.2',
        creator: {
          name: 'Browz Performance & Network Capture Browser',
          version: '1.0.0'
        },
        pages: [
          {
            startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(),
            id: 'page_1',
            title: 'Browz Captured Session',
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1
            }
          }
        ],
        entries: harEntries
      }
    },
    null,
    2
  );
}

function toK6Script(entries) {
  const activeEntries = entries.filter((e) => !e.blocked && e.url && e.url.startsWith('http'));
  const lines = [
    '// Auto-generated by Browz Performance Capture Browser',
    `// Captured Requests: ${activeEntries.length} | Generated: ${new Date().toISOString()}`,
    "import http from 'k6/http';",
    "import { check, sleep, group } from 'k6';",
    '',
    'export const options = {',
    '  stages: [',
    "    { duration: '15s', target: 10 }, // Ramp up to 10 virtual users",
    "    { duration: '30s', target: 10 }, // Steady state load",
    "    { duration: '10s', target: 0 }   // Ramp down",
    '  ],',
    '  thresholds: {',
    "    http_req_duration: ['p(95)<500', 'p(99)<1000'],",
    "    http_req_failed: ['rate<0.02']",
    '  }',
    '};',
    '',
    'export default function () {',
    "  group('Browz Recorded User Flow', function () {"
  ];

  activeEntries.forEach((e, idx) => {
    const method = (e.method || 'GET').toUpperCase();
    const safeUrl = JSON.stringify(e.url);
    const headers = {};
    for (const { name, value } of objectToHeaderList(e.requestHeaders)) {
      const lower = name.toLowerCase();
      if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(lower)) {
        headers[name] = value;
      }
    }
    const paramsStr = JSON.stringify({ headers }, null, 4).replace(/\n/g, '\n    ');
    const varName = `res_${idx + 1}`;

    lines.push(`    // [${idx + 1}] ${method} ${e.url} (Captured: ${e.timings?.total || 0}ms, Status: ${e.status})`);
    if (method === 'GET' || method === 'HEAD') {
      lines.push(`    const ${varName} = http.${method.toLowerCase()}(${safeUrl}, ${paramsStr});`);
    } else {
      const bodyStr = e.requestBody ? JSON.stringify(String(e.requestBody)) : 'null';
      lines.push(`    const ${varName} = http.request(${JSON.stringify(method)}, ${safeUrl}, ${bodyStr}, ${paramsStr});`);
    }
    const expectedStatus = e.status >= 200 && e.status < 400 ? e.status : 200;
    lines.push(`    check(${varName}, {`);
    lines.push(`      'status is ${expectedStatus}': (r) => r.status === ${expectedStatus},`);
    lines.push(`      'duration < 1000ms': (r) => r.timings.duration < 1000`);
    lines.push('    });');
    lines.push('');
  });

  lines.push('    sleep(1);');
  lines.push('  });');
  lines.push('}');
  return lines.join('\n');
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toJMeterJMX(entries) {
  const activeEntries = entries.filter((e) => !e.blocked && e.url && e.url.startsWith('http'));
  const samplers = activeEntries
    .map((e, i) => {
      let parsed;
      try {
        parsed = new URL(e.url);
      } catch {
        return '';
      }
      const protocol = parsed.protocol.replace(':', '');
      const domain = parsed.hostname;
      const port = parsed.port || (protocol === 'https' ? '443' : '80');
      const pathAndQuery = parsed.pathname + (parsed.search || '');
      const method = (e.method || 'GET').toUpperCase();
      const bodyXml = e.requestBody
        ? `<boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="" elementType="HTTPArgument">
                <boolProp name="HTTPArgument.always_encode">false</boolProp>
                <stringProp name="Argument.value">${escapeXml(e.requestBody)}</stringProp>
                <stringProp name="Argument.metadata">=</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>`
        : `<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>`;

      const headersXml = objectToHeaderList(e.requestHeaders)
        .map(
          (h) => `<elementProp name="" elementType="Header">
                <stringProp name="Header.name">${escapeXml(h.name)}</stringProp>
                <stringProp name="Header.value">${escapeXml(h.value)}</stringProp>
              </elementProp>`
        )
        .join('\n              ');

      return `
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="[${i + 1}] ${escapeXml(method)} ${escapeXml(parsed.pathname)}" enabled="true">
          ${bodyXml}
          <stringProp name="HTTPSampler.domain">${escapeXml(domain)}</stringProp>
          <stringProp name="HTTPSampler.port">${escapeXml(port)}</stringProp>
          <stringProp name="HTTPSampler.protocol">${escapeXml(protocol)}</stringProp>
          <stringProp name="HTTPSampler.path">${escapeXml(pathAndQuery)}</stringProp>
          <stringProp name="HTTPSampler.method">${escapeXml(method)}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
        </HTTPSamplerProxy>
        <hashTree>
          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager" enabled="true">
            <collectionProp name="HeaderManager.headers">
              ${headersXml}
            </collectionProp>
          </HeaderManager>
          <hashTree/>
        </hashTree>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Browz Captured Performance Test Plan" enabled="true">
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Browz Virtual Users" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" enabled="true">
          <stringProp name="LoopController.loops">1</stringProp>
          <boolProp name="LoopController.continue_forever">false</boolProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">10</stringProp>
        <stringProp name="ThreadGroup.ramp_time">5</stringProp>
      </ThreadGroup>
      <hashTree>
        ${samplers}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}

function toCSV(entries) {
  const header = [
    'Seq',
    'Timestamp',
    'Tab',
    'Container',
    'Method',
    'Status',
    'Type',
    'Protocol',
    'URL',
    'ReqSizeB',
    'ResSizeB',
    'DNS_ms',
    'Connect_ms',
    'TLS_ms',
    'TTFB_Wait_ms',
    'Download_ms',
    'Total_ms'
  ];
  const rows = entries.map((e) => {
    const t = e.timings || {};
    const cols = [
      e.seq || '',
      e.startedDateTime || '',
      e.tabId || '',
      e.containerId || '',
      e.method || 'GET',
      e.blocked ? 'BLOCKED' : e.status || 0,
      e.resourceType || 'Other',
      e.protocol || 'HTTP/1.1',
      `"${String(e.url || '').replace(/"/g, '""')}"`,
      e.requestBodySize || 0,
      e.transferSize || e.responseBodySize || 0,
      t.dns || 0,
      t.connect || 0,
      t.ssl || 0,
      t.wait || 0,
      t.receive || 0,
      t.total || 0
    ];
    return cols.join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

function toCurl(entry) {
  const parts = [`curl -X ${entry.method || 'GET'} '${String(entry.url || '').replace(/'/g, "'\\''")}'`];
  for (const { name, value } of objectToHeaderList(entry.requestHeaders)) {
    parts.push(`  -H '${name}: ${String(value).replace(/'/g, "'\\''")}'`);
  }
  if (entry.requestBody) {
    parts.push(`  --data-raw '${String(entry.requestBody).replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n');
}

function toFetch(entry) {
  const headers = {};
  for (const { name, value } of objectToHeaderList(entry.requestHeaders)) {
    headers[name] = value;
  }
  const opts = {
    method: entry.method || 'GET',
    headers
  };
  if (entry.requestBody && !['GET', 'HEAD'].includes(opts.method.toUpperCase())) {
    opts.body = entry.requestBody;
  }
  return `const response = await fetch(${JSON.stringify(entry.url)}, ${JSON.stringify(opts, null, 2)});\nconst data = await response.text();\nconsole.log(response.status, data);`;
}

module.exports = {
  computeMetrics,
  objectToHeaderList,
  toHAR,
  toK6Script,
  toJMeterJMX,
  toCSV,
  toCurl,
  toFetch
};
