#!/usr/bin/env node
// Alertmanager → Slack / PagerDuty bridge.
//
// Alertmanager's generic webhook payload is not a Slack incoming-webhook body and not a
// PagerDuty Events API v2 envelope. Pointing `webhook_configs.url` at either of those
// directly is a 4xx and a silent pager. This process is the missing hop:
//   * always logs the group (so `npm run ops:prometheus` pages *somewhere* out of the box)
//   * if SLACK_WEBHOOK_URL is set, posts a Slack attachment
//   * if PAGERDUTY_ROUTING_KEY is set, posts Events API v2 trigger/resolve
//
// Bound on 0.0.0.0:5001. Alertmanager reaches it as http://alert-webhook:5001/alerts on the
// compose `internal` network; egress to Slack/PagerDuty goes out the `edge` network.
import http from 'node:http';

const PORT = Number(process.env.PORT || 5001);
const SLACK = process.env.SLACK_WEBHOOK_URL || '';
const PD_KEY = process.env.PAGERDUTY_ROUTING_KEY || '';

export function severityOf(alert) {
  const s = String(alert?.labels?.severity ?? 'warn');
  if (s === 'page') return 'critical';
  if (s === 'ticket') return 'error';
  return 'warning';
}

export function slackBody(payload) {
  const status = payload.status === 'resolved' ? 'RESOLVED' : 'FIRING';
  const color = payload.status === 'resolved' ? 'good' : 'danger';
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const lines = alerts.slice(0, 8).map((a) => {
    const name = a.labels?.alertname ?? 'alert';
    const summary = a.annotations?.summary ?? a.annotations?.description ?? '';
    return `• ${name}: ${summary}`;
  });
  return {
    text: `${status} ${payload.groupLabels?.alertname ?? 'guttercaps'} (${alerts.length})`,
    attachments: [{ color, text: lines.join('\n') || status, mrkdwn_in: ['text'] }],
  };
}

export function pagerDutyBodies(payload) {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const action = payload.status === 'resolved' ? 'resolve' : 'trigger';
  return alerts.map((a) => {
    const name = a.labels?.alertname ?? 'alert';
    const dedup = [name, a.fingerprint, a.labels?.service].filter(Boolean).join('/');
    return {
      routing_key: PD_KEY,
      event_action: action,
      dedup_key: dedup.slice(0, 255),
      payload: {
        summary: a.annotations?.summary ?? name,
        severity: severityOf(a),
        source: 'guttercaps-alertmanager',
        custom_details: { description: a.annotations?.description ?? '', labels: a.labels ?? {} },
      },
    };
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text().catch(() => '')}`);
}

function selftest() {
  const firing = {
    status: 'firing',
    groupLabels: { alertname: 'ApiDown' },
    alerts: [{
      status: 'firing', fingerprint: 'abc',
      labels: { alertname: 'ApiDown', severity: 'page', service: 'api' },
      annotations: { summary: 'API is not answering scrapes', description: 'check compose' },
    }],
  };
  const slack = slackBody(firing);
  if (!/FIRING/.test(slack.text) || !/ApiDown/.test(slack.attachments[0].text)) {
    console.error('selftest: slack body missing firing/ApiDown');
    return 1;
  }
  const pd = pagerDutyBodies({ ...firing, status: 'resolved' });
  if (pd.length !== 1 || pd[0].event_action !== 'resolve' || pd[0].payload.severity !== 'critical') {
    console.error('selftest: pagerduty body wrong', pd);
    return 1;
  }
  console.log('selftest: slack + pagerduty translators ok');
  return 0;
}

function listen() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/alerts') {
      res.writeHead(404); res.end(); return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { res.writeHead(400); res.end('invalid json'); return; }
    const n = Array.isArray(payload.alerts) ? payload.alerts.length : 0;
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      status: payload.status,
      alerts: n,
      names: (payload.alerts ?? []).map((a) => a.labels?.alertname),
      slack: Boolean(SLACK),
      pagerduty: Boolean(PD_KEY),
    }));
    try {
      if (SLACK) await postJson(SLACK, slackBody(payload));
      if (PD_KEY) {
        for (const body of pagerDutyBodies(payload)) {
          await postJson('https://events.pagerduty.com/v2/enqueue', body);
        }
      }
    } catch (e) {
      console.error('forward failed', e);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(e));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`alert-webhook listening on 0.0.0.0:${PORT} slack=${Boolean(SLACK)} pagerduty=${Boolean(PD_KEY)}`);
  });
}

if (process.argv.includes('--selftest')) process.exit(selftest());
if (import.meta.url === `file://${process.argv[1]}`) listen();
