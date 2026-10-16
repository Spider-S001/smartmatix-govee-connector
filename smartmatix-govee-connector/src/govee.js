'use strict';

/**
 * govee.js – Client für die Govee OpenAPI (Cloud)
 *
 * Doku: https://developer.govee.com/reference/get-you-devices
 *
 * Endpunkte:
 *   GET  /router/api/v1/user/devices    – Geräte + Capabilities des Accounts
 *   POST /router/api/v1/device/state    – aktueller Zustand eines Geräts
 *   POST /router/api/v1/device/control  – eine Capability eines Geräts setzen
 *
 * Authentifizierung: Header "Govee-API-Key".
 *
 * Limits (laut Govee):
 *   - Geräteliste: 30 req/min/Account
 *   - State:       30 req/min/Gerät
 *   - Control:     ca. 2 req/s/Gerät, 12 req/s/Account
 *   - zusätzlich ein Tageskontingent pro Account (DAILY_REQUEST_LIMIT),
 *     auf das das Polling-Intervall in plugin.js ausgelegt wird.
 */

const https          = require('https');
const { v4: uuidv4 } = require('uuid');
const log            = require('./logger');

const API_HOST            = 'openapi.api.govee.com';
const API_BASE            = '/router/api/v1';
const REQUEST_TIMEOUT_MS  = 10_000;
const DAILY_REQUEST_LIMIT = 10_000;

/** Fehlerklasse mit HTTP-/API-Status, damit plugin.js z. B. 401 und 429 unterscheiden kann. */
class GoveeApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name   = 'GoveeApiError';
    this.status = status;
  }
  get isAuthError()  { return this.status === 401 || this.status === 403; }
  get isRateLimit()  { return this.status === 429; }
  /** Cloud nicht erreichbar: Netzwerkfehler/Timeout (kein HTTP-Status) oder Serverfehler 5xx. */
  get isConnectionError() { return this.status === null || this.status >= 500; }
}

// ---------------------------------------------------------------------------
//  Interner HTTPS-Helper
// ---------------------------------------------------------------------------

function request(apiKey, method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: API_HOST,
      port:     443,
      path:     `${API_BASE}${apiPath}`,
      method,
      timeout:  REQUEST_TIMEOUT_MS,
      headers:  {
        'Content-Type':  'application/json',
        'Govee-API-Key': apiKey,
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        log.debug(`Govee ${method} ${apiPath} – HTTP ${res.statusCode}: ${raw.substring(0, 300)}`);

        let json = null;
        try { json = raw.trim() ? JSON.parse(raw) : null; } catch { /* unten behandelt */ }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = json?.message ?? json?.msg ?? raw.substring(0, 120);
          return reject(new GoveeApiError(`Govee ${method} ${apiPath}: HTTP ${res.statusCode} ${msg}`, res.statusCode));
        }
        if (!json) {
          return reject(new GoveeApiError(`Govee ${method} ${apiPath}: ungueltige JSON-Antwort`, res.statusCode));
        }
        // Govee liefert Fehler teils mit HTTP 200 und code != 200 im Body
        if (json.code !== undefined && Number(json.code) !== 200) {
          return reject(new GoveeApiError(`Govee ${method} ${apiPath}: ${json.message ?? json.msg ?? 'Fehler'} (code ${json.code})`, Number(json.code)));
        }
        resolve(json);
      });
    });

    req.on('timeout', () => req.destroy(new GoveeApiError(`Govee API Timeout (${REQUEST_TIMEOUT_MS}ms) fuer ${apiPath}`)));
    req.on('error',   (err) => reject(err instanceof GoveeApiError ? err : new GoveeApiError(err.message)));

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Liefert alle Geräte des Accounts.
 * @returns {Promise<Array<{sku, device, deviceName, type, capabilities}>>}
 */
async function listDevices(apiKey) {
  const res = await request(apiKey, 'GET', '/user/devices');
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Liefert die Capabilities mit aktuellem Zustand eines Geräts.
 * @returns {Promise<Array<{type, instance, state:{value}}>>}
 */
async function getState(apiKey, sku, device) {
  const res = await request(apiKey, 'POST', '/device/state', {
    requestId: uuidv4(),
    payload:   { sku, device },
  });
  return Array.isArray(res.payload?.capabilities) ? res.payload.capabilities : [];
}

/**
 * Setzt genau eine Capability eines Geräts (Govee erlaubt eine pro Request).
 * @param {{type:string, instance:string, value:*}} capability
 */
async function control(apiKey, sku, device, capability) {
  await request(apiKey, 'POST', '/device/control', {
    requestId: uuidv4(),
    payload:   { sku, device, capability },
  });
  log.info(`Govee control ${sku}/${device}: ${capability.instance} = ${JSON.stringify(capability.value)}`);
}

/**
 * Führt mehrere Steuerbefehle nacheinander aus – mit Wiederholung bei
 * Netzwerkfehlern/429 und kurzer Pause, um das Geräte-Limit einzuhalten.
 * @returns {Promise<{ok:boolean, error:GoveeApiError|null}>}
 */
async function controlSequence(apiKey, sku, device, capabilities) {
  const MAX_RETRIES    = 3;
  const RETRY_DELAY_MS = 1000;
  const GAP_MS         = 350;

  for (let i = 0; i < capabilities.length; i++) {
    if (i > 0) await sleep(GAP_MS);
    const cap = capabilities[i];
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await control(apiKey, sku, device, cap);
        break;
      } catch (err) {
        const retryable = !err.isAuthError && (err.isRateLimit || err.status === null || err.status >= 500);
        if (!retryable || attempt === MAX_RETRIES) {
          log.error(`Govee control ${sku}/${device} ${cap.instance} fehlgeschlagen: ${err.message}`);
          return { ok: false, error: err };
        }
        log.warn(`Govee control ${cap.instance} Versuch ${attempt}/${MAX_RETRIES} fehlgeschlagen: ${err.message} – wiederhole.`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  return { ok: true, error: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  listDevices,
  getState,
  control,
  controlSequence,
  GoveeApiError,
  DAILY_REQUEST_LIMIT,
};
