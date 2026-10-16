'use strict';

/**
 * plugin.js – Kernklasse des SmartMatix Govee Connectors
 *
 * Verwaltet:
 *   • WebSocket-Verbindung zur HCU (inkl. Exponential-Backoff-Reconnect)
 *   • Protokoll gemäß Connect API 1.0.1
 *   • Anmeldung an der Govee OpenAPI per API-Key
 *   • Auswahl der Govee-Geräte in den Plugin-Einstellungen (Haken je Gerät)
 *   • "Neue Geräte automatisch hinzufügen"
 *   • Reinklusion in der HCU gelöschter Geräte beim Speichern und beim Start
 *   • Steuerung und Status-Polling: Lampen lokal über die Govee LAN-API,
 *     alle übrigen Geräte über die Cloud (auf das Govee-Tageskontingent ausgelegt)
 *   • Mitteilungen in der Homematic IP App bei Cloud-Fehlern
 *
 * Ablauf Geräteaufnahme:
 *   1. Nutzer trägt den Govee-API-Key ein und speichert.
 *   2. Das Plugin lädt die Geräteliste des Accounts (govee.json). Neue Geräte
 *      erhalten den Haken "Zu Homematic IP hinzufügen" = autoAddNewDevices.
 *      Bei einem Wechsel auf ein anderes Konto werden die Geräte des alten
 *      Kontos entfernt.
 *   3. Für jedes Gerät mit Haken werden HCU-Geräte angelegt (devices.json)
 *      und per DISCOVER_RESPONSE an die HCU gemeldet.
 *   4. EXCLUSION_EVENT (Gerät in der App gelöscht) > Gerät wird nicht mehr
 *      bedient. Ist der Haken weiterhin gesetzt, wird es beim nächsten
 *      Speichern der Einstellungen oder Plugin-Start erneut gemeldet.
 *   5. Haken entfernt > HCU-Gerät wird nicht mehr bedient, in der App
 *      erscheint ein Hinweis, das Gerät dort zu löschen (die Connect API
 *      erlaubt dem Plugin kein Löschen).
 */

const WebSocket      = require('ws');
const { v4: uuidv4 } = require('uuid');
const log            = require('./logger');
const devices        = require('./devices');
const configStore    = require('./configStore');
const devicesStore   = require('./devicesStore');
const govee          = require('./govee');
const mapping        = require('./goveeMapping');
const { t }          = require('./localization');
const { createNotifier }   = require('./notifications');
const backup               = require('./backup-plugin-data');
const { GoveeLanClient }   = require('./goveeLan');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------
const REPO_URL    = 'https://github.com/Spider-S001/smartmatix-govee-connector';

// Port des temporären Backup/Restore-Servers – muss zu EXPOSE im Dockerfile passen
const BACKUP_PORT = 8746;

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

// Nach einem Steuerbefehl wird das Polling für das Govee-Gerät so lange
// ignoriert, damit ein Poll den gerade gesetzten Zustand nicht überschreibt
// (die Govee-Cloud meldet neue Zustände teils mit Verzögerung).
const CONTROL_GRACE_MS = 15_000;

// Lokale Steuerung (Govee LAN-API): kein Anfragelimit > kurze Intervalle
const LAN_POLL_MS       = 5_000;          // Statusabfrage lokal erreichbarer Lampen
const LAN_SCAN_MS       = 5 * 60 * 1000;  // Subnetz-Scan (neue Lampen, geänderte IPs)
const LAN_GRACE_MS      = 2_000;          // Schonfrist nach lokalem Steuerbefehl
const LAN_CMD_GAP_MS    = 120;            // Pause zwischen zwei lokalen Befehlen
const LAN_VERIFY_MS     = 350;            // Wartezeit vor der Kontrollabfrage

// Geräteliste regelmäßig neu laden, um neue Geräte zu erkennen (Auto-Add)
const DEVICE_LIST_REFRESH_MS  = 60 * 60 * 1000;
// Beim Öffnen der Einstellungen wird die Liste neu geladen, wenn sie älter ist
const DEVICE_LIST_MAX_AGE_MS  = 60 * 1000;

// Anteil des Govee-Tageskontingents, den das Polling maximal nutzen darf
// (Rest bleibt für Steuerbefehle und Gerätelisten)
const POLL_BUDGET_SHARE = 0.7;

const POLL_OPTIONS = { '60s': 60, '2min': 120, '5min': 300, '10min': 600, '15min': 900, '30min': 1800, '1h': 3600 };

// Feste Message-IDs (self-replacing notifications)
const MSG_ID_API_ERROR   = 'govee-api-error';
const MSG_ID_RATE_LIMIT  = 'govee-rate-limit';
const MSG_ID_REMOVE_HINT = 'govee-remove-hint';

const GOVEE_TYPE_KEYS = {
  'devices.types.light':          'light',
  'devices.types.air_purifier':   'air_purifier',
  'devices.types.thermometer':    'thermometer',
  'devices.types.socket':         'socket',
  'devices.types.sensor':         'sensor',
  'devices.types.heater':         'heater',
  'devices.types.humidifier':     'humidifier',
  'devices.types.dehumidifier':   'dehumidifier',
  'devices.types.ice_maker':      'ice_maker',
  'devices.types.aroma_diffuser': 'aroma_diffuser',
  'devices.types.fan':            'fan',
  'devices.types.kettle':         'kettle',
  'devices.types.box':            'box',
};


class Plugin {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId  – Eindeutige Plugin-ID
   * @param {string} opts.host      – Hostname/IP der HCU
   * @param {string} opts.authtoken – Auth-Token der HCU
   */
  constructor({ pluginId, host, authtoken }) {
    this.pluginId  = pluginId;
    this.host      = host;
    this.authtoken = authtoken;

    this._config = configStore.load();
    this._lang   = 'de';

    this._ws             = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._stopping       = false;

    this._pollTimer        = null;
    this._polling          = false;
    this._listTimer        = null;

    // Reinklusion: nächster DISCOVER meldet ALLE angehakten Geräte erneut
    this._reincludePending = false;
    this._startupDone      = false;

    // Lokale Steuerung (Govee LAN-API, UDP 4001/4002/4003)
    this._lan         = new GoveeLanClient({ onChange: () => this._onLanChange() });
    this._hcuIp       = null;
    this._lanPollTimer = null;
    this._lanScanTimer = null;
    this._lanPolling   = false;
    this._pendingSystemInfo = new Map();
    this._controlGraceUntil = new Map();   // goveeId > Timestamp

    // Zustand der Govee-API-Verbindung (für die Einstellungsseite)
    this._api = { ok: null, error: null, lastListAt: 0, refreshing: null };

    this._notify        = null;
    this._backupManager = backup.create({ port: BACKUP_PORT });
    try {
      const sgtin = require('fs').readFileSync('/SGTIN', 'utf8').trim();
      this._backupHost = `hcu1-${sgtin.slice(-4)}.local`;
    } catch {
      this._backupHost = 'localhost';
    }

    log.info(`API-Key: ${this._config.apiKey ? 'hinterlegt' : 'nicht hinterlegt'}, Auto-Add: ${this._config.autoAddNewDevices ? 'an' : 'aus'}`);
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  start() {
    this._stopping = false;
    this._connect();
  }

  stop() {
    log.info('Plugin wird beendet...');
    this._stopping = true;
    this._clearReconnect();
    this._stopPolling();
    this._stopListRefresh();
    this._stopLan();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  //  WebSocket-Lifecycle
  // ---------------------------------------------------------------------------

  _connect() {
    const url = `wss://${this.host}:9001`;
    log.info(`Verbinde zu ${url} ...`);

    this._ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout:   30_000,
      headers: {
        'authtoken': this.authtoken,
        'plugin-id': this.pluginId,
      },
    });

    this._ws.on('open',    ()             => this._onOpen());
    this._ws.on('message', (data)         => this._onMessage(data));
    this._ws.on('error',   (err)          => this._onError(err));
    this._ws.on('close',   (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    log.info('WebSocket verbunden.');
    this._reconnectDelay = RECONNECT_BASE_MS;

    this._notify = createNotifier(this.pluginId, (msg) => this._send(msg), t);

    this._sendPluginState(uuidv4());

    if (this._config.apiKey) {
      // Geräteliste aktualisieren (erkennt neue Geräte), dann echte Zustände senden
      this._refreshGoveeDevices()
        .catch(err => log.warn('Start: Geraeteliste konnte nicht geladen werden:', err.message))
        .finally(() => {
          // Beim Plugin-Start: angehakte Geräte, die in der App gelöscht wurden, wieder hinzufügen
          if (!this._startupDone) {
            this._startupDone = true;
            this._syncHcuDevices({ reinclude: true });
            this._requestReinclude('Plugin-Start');
          }
          this._pollAllDevices({ force: true }).catch(err => log.warn('Start: Zustandsabruf fehlgeschlagen:', err.message));
          this._startPolling();
        });
      this._startListRefresh();
    }
    this._startLan().catch(err => log.warn('Govee LAN: Start fehlgeschlagen:', err.message));
  }

  async _onMessage(raw) {
    let message;
    try {
      const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      message = JSON.parse(decoded);
    } catch {
      log.warn('Ungueltige JSON-Nachricht empfangen:', raw.toString());
      return;
    }

    log.debug('< HCU:', JSON.stringify(message));

    try {
      switch (message.type) {
        case 'PLUGIN_STATE_REQUEST':    this._sendPluginState(message.id); break;
        case 'DISCOVER_REQUEST':        this._sendDiscoverResponse(message.id); break;
        case 'INCLUSION_EVENT':         this._handleInclusionEvent(message); break;
        case 'EXCLUSION_EVENT':         this._handleExclusionEvent(message); break;
        case 'CONTROL_REQUEST':         await this._handleControlRequest(message); break;
        case 'STATUS_REQUEST':          this._handleStatusRequest(message); break;
        case 'CONFIG_TEMPLATE_REQUEST': this._handleConfigTemplateRequest(message); break;
        case 'CONFIG_UPDATE_REQUEST':   await this._handleConfigUpdateRequest(message); break;
        case 'SYSTEM_INFO_RESPONSE': {
          const pending = this._pendingSystemInfo.get(message.id);
          if (pending) { this._pendingSystemInfo.delete(message.id); pending(message.body ?? {}); }
          log.info('SYSTEM_INFO_RESPONSE:', JSON.stringify(message.body));
          break;
        }
        case 'ERROR_RESPONSE':
          log.warn('ERROR_RESPONSE der HCU:', JSON.stringify(message.body));
          break;
        default:
          log.debug(`Nicht behandelter Nachrichtentyp: "${message.type}"`);
      }
    } catch (e) {
      log.error(`${message.type} Handler-Fehler:`, e.message, e.stack);
    }
  }

  _onError(err) {
    log.error('WebSocket-Fehler:', err.code ?? '', err.message ?? err);
  }

  _onClose(code, reason) {
    log.warn(`WebSocket getrennt (Code: ${code}, Grund: ${reason ? reason.toString() : '-'})`);
    this._stopPolling();
    this._stopListRefresh();
    this._stopLan();
    if (!this._stopping) this._scheduleReconnect();
  }

  // ---------------------------------------------------------------------------
  //  Ausgehende Nachrichten
  // ---------------------------------------------------------------------------

  _send(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      log.warn('_send() aufgerufen, aber WebSocket ist nicht offen.');
      return;
    }
    const payload = JSON.stringify(message);
    log.debug('> HCU:', payload);
    this._ws.send(payload);
  }

  _reply(request, type, body) {
    this._send({ id: request?.id ?? uuidv4(), pluginId: this.pluginId, type, body });
  }

  /**
   * PLUGIN_STATE_RESPONSE – READY, bzw. CONFIG_REQUIRED solange kein
   * Govee-API-Key hinterlegt ist.
   */
  _sendPluginState(messageId) {
    const status = this._config.apiKey ? 'READY' : 'CONFIG_REQUIRED';
    log.info(`Sende PLUGIN_STATE_RESPONSE { ${status} }`);
    this._send({
      id:       messageId,
      pluginId: this.pluginId,
      type:     'PLUGIN_STATE_RESPONSE',
      body:     { pluginReadinessStatus: status },
    });
  }

  _sendStatusEvent(deviceId, features) {
    features = devices.statusFeatures(features);
    if (!features?.length) return;
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'STATUS_EVENT',
      body:     { deviceId, features },
    });
  }

  // ---------------------------------------------------------------------------
  //  Geräteaufnahme (DISCOVER / INCLUSION / EXCLUSION)
  // ---------------------------------------------------------------------------

  /** Meldet beim nächsten DISCOVER alle angehakten Geräte erneut und triggert ihn. */
  _requestReinclude(reason) {
    if (devices.getAll().length === 0) return;
    log.info(`Reinklusion angefordert (${reason}): alle angehakten Geraete werden erneut gemeldet.`);
    this._reincludePending = true;
    this._triggerRediscover();
  }

  /**
   * Triggert einen DISCOVER_REQUEST der HCU. Die HCU fragt nach jeder
   * PLUGIN_STATE_RESPONSE mit READY nach Geräten.
   */
  _triggerRediscover() {
    log.info('Triggere DISCOVER_REQUEST via PLUGIN_STATE_RESPONSE ...');
    this._sendPluginState(uuidv4());
  }

  /**
   * DISCOVER_RESPONSE an die HCU.
   *   - Nach _requestReinclude() (Speichern/Start): alle angehakten Geräte.
   *   - Sonst: nur Geräte, die noch nie gemeldet wurden. In der HCU gelöschte
   *     Geräte (excluded) bleiben dann bis zur nächsten Reinklusion außen vor.
   */
  _sendDiscoverResponse(messageId = null) {
    const reinclude = this._reincludePending;
    this._reincludePending = false;

    // Reinklusion (nach Speichern/Start): alle angehakten Geräte erneut melden –
    // so kommen auch Geräte zurück, die gelöscht wurden, während das Plugin
    // nicht lief (dann gab es kein EXCLUSION_EVENT).
    // Sonst: nur noch nie gemeldete Geräte.
    const toReport = reinclude
      ? devices.getAll()
      : devices.getAll().filter(d => !d.alreadyIncluded && !d.excluded);

    this._send({
      id:       messageId ?? uuidv4(),
      pluginId: this.pluginId,
      type:     'DISCOVER_RESPONSE',
      body:     { success: true, devices: toReport.map(d => devices.toHcu(d, { forDiscover: true })) },
    });

    devices.setFlags(toReport.map(d => d.deviceId), { alreadyIncluded: true, excluded: false });
    log.info(`DISCOVER_RESPONSE gesendet mit ${toReport.length} Geraet(en)${reinclude ? ' (Reinklusion)' : ''}.`);
  }

  /** INCLUSION_EVENT > Zustände der eingebundenen Geräte senden. */
  _handleInclusionEvent(message) {
    const ids = message.body?.deviceIds ?? [];
    log.info(`INCLUSION_EVENT fuer ${ids.length} Geraet(e).`);
    devices.setFlags(ids, { alreadyIncluded: true, excluded: false });

    const included = ids.map(id => devices.getById(id)).filter(Boolean);
    this._reply(message, 'STATUS_RESPONSE', { success: true, devices: included.map(d => devices.toHcu(d)) });

    // Live-Zustand der betroffenen Govee-Geräte nachladen
    const goveeIds = [...new Set(included.map(d => d.goveeId))];
    this._pollAllDevices({ force: true, onlyGoveeIds: goveeIds })
      .catch(err => log.debug('INCLUSION_EVENT: Refresh fehlgeschlagen:', err.message));
    this._pushConfigTemplate();
  }

  /** EXCLUSION_EVENT > Geräte wurden in der HCU gelöscht: nicht mehr bedienen. */
  _handleExclusionEvent(message) {
    const ids = message.body?.deviceIds ?? [];
    log.info(`EXCLUSION_EVENT fuer ${ids.length} Geraet(e): ${ids.join(', ')}`);
    devices.setFlags(ids, { alreadyIncluded: false, excluded: true });
    this._pushConfigTemplate();
  }

  // ---------------------------------------------------------------------------
  //  Steuerung und Status
  // ---------------------------------------------------------------------------

  /** CONTROL_REQUEST > Govee steuern > CONTROL_RESPONSE */
  async _handleControlRequest(message) {
    const { deviceId, features } = message.body ?? {};
    log.info(`CONTROL_REQUEST fuer ${deviceId}:`, JSON.stringify(features));

    const fail = (code, msg) => {
      log.warn(`CONTROL_REQUEST ${deviceId} fehlgeschlagen: ${msg}`);
      this._reply(message, 'CONTROL_RESPONSE', { deviceId, success: false, error: { code, message: msg } });
    };

    const device = devices.getById(deviceId);
    if (!device || device.excluded) return fail('UNKNOWN_DEVICE', 'Device is not managed by this plugin anymore.');
    if (!Array.isArray(features) || features.length === 0) return fail('INVALID_REQUEST', 'No features in control request.');
    if (!this._config.apiKey) return fail('CONFIG_REQUIRED', 'Govee API key missing.');

    const gdev = this._findGovee(device.goveeId);
    if (!gdev) return fail('UNKNOWN_DEVICE', 'Govee device not found.');

    const cmds = mapping.featuresToCommands(device, features, device.features, gdev);

    // Lampen mit LAN-API lokal steuern; bei Fehlschlag automatisch über die Cloud
    let viaLan = false;
    if (cmds.length && device.channel === 'main' && this._isLan(gdev)) {
      this._controlGraceUntil.set(device.goveeId, Date.now() + LAN_GRACE_MS);
      viaLan = await this._lanControl(gdev, cmds);
      if (!viaLan) log.warn(`CONTROL_REQUEST ${deviceId}: lokal fehlgeschlagen > Cloud.`);
    }

    let res = { ok: true, error: null };
    if (cmds.length && !viaLan) {
      this._controlGraceUntil.set(device.goveeId, Date.now() + CONTROL_GRACE_MS);
      res = await govee.controlSequence(this._config.apiKey, gdev.sku, gdev.id, cmds);
    }

    if (!res.ok) {
      if (res.error && (res.error.isConnectionError || res.error.isAuthError || res.error.isRateLimit)) {
        this._handleApiError(res.error);
      }
      return fail('GOVEE_ERROR', res.error?.message ?? 'Govee API did not accept the command.');
    }
    if (cmds.length && !viaLan) this._markApiOk();

    // Übernommenen Zustand speichern und zurückmelden (ohne Spezialwerte)
    const applied = mapping.appliedFeatures(device, features, device.features, gdev);
    devices.mergeFeatures(deviceId, applied);
    this._reply(message, 'CONTROL_RESPONSE', { deviceId, success: true });
    this._sendStatusEvent(deviceId, applied);
  }

  /** STATUS_REQUEST > gespeicherte Zustände liefern, live nachladen. */
  _handleStatusRequest(message) {
    const requested = message.body?.deviceIds
      ?? (message.body?.deviceId ? [message.body.deviceId] : null);

    const list = (requested ? requested.map(id => devices.getById(id)) : devices.getActive())
      .filter(d => d && !d.excluded);

    log.info(`STATUS_REQUEST fuer ${requested ? requested.join(', ') : 'alle Geraete'} > ${list.length} Geraet(e).`);
    for (const d of list) {
      if (d.deviceType === 'LIGHT') log.info(`STATUS_RESPONSE ${d.friendlyName}: ${describeLight(devices.statusFeatures(d.features))}`);
    }
    this._reply(message, 'STATUS_RESPONSE', { success: true, devices: list.map(d => devices.toHcu(d)) });

    const goveeIds = [...new Set(list.map(d => d.goveeId))];
    if (goveeIds.length && this._config.apiKey) {
      this._pollAllDevices({ onlyGoveeIds: goveeIds })
        .catch(err => log.debug('STATUS_REQUEST: Refresh fehlgeschlagen:', err.message));
    }
  }

  // ---------------------------------------------------------------------------
  //  Govee-Geräteliste
  // ---------------------------------------------------------------------------

  _loadGovee()       { return devicesStore.loadGoveeDevices(); }
  _findGovee(id)     { return this._loadGovee().find(g => g.id === id) ?? null; }

  /**
   * Lädt die Geräteliste des Govee-Accounts und gleicht sie mit govee.json ab.
   * Neue Geräte erhalten addToHcu = autoAddNewDevices. Gleichzeitige Aufrufe
   * teilen sich einen laufenden Request.
   *
   * @returns {Promise<{newCount:number, autoAdded:number}>}
   */
  _refreshGoveeDevices({ prune = false } = {}) {
    if (this._api.refreshing) return this._api.refreshing;

    this._api.refreshing = (async () => {
      const apiKey = this._config.apiKey;
      if (!apiKey) return { newCount: 0, autoAdded: 0 };

      let list;
      try {
        list = await govee.listDevices(apiKey);
      } catch (err) {
        this._handleApiError(err);
        throw err;
      }

      this._api.lastListAt = Date.now();
      this._markApiOk();

      const stored  = this._loadGovee();
      const byId    = new Map(stored.map(g => [g.id, g]));
      const seen    = new Set();
      let newCount  = 0;
      let autoAdded = 0;

      for (const d of list) {
        if (!d?.device) continue;
        seen.add(d.device);
        const rec = byId.get(d.device);
        if (rec) {
          Object.assign(rec, {
            sku: d.sku, name: d.deviceName || rec.name, type: d.type,
            capabilities: d.capabilities ?? [], available: true,
          });
        } else {
          const supported = mapping.buildChannels({ id: d.device, type: d.type, capabilities: d.capabilities }).length > 0;
          const add = Boolean(this._config.autoAddNewDevices && supported);
          const newRec = {
            id:           d.device,
            sku:          d.sku,
            name:         d.deviceName || `${d.sku} ${d.device.slice(-5)}`,
            type:         d.type,
            capabilities: d.capabilities ?? [],
            addToHcu:     add,
            available:    true,
            firstSeen:    new Date().toISOString(),
          };
          stored.push(newRec);
          byId.set(d.device, newRec);
          newCount++;
          if (add) autoAdded++;
          log.info(`Govee: Neues Geraet "${newRec.name}" (${newRec.sku}) gefunden${add ? ' > wird automatisch hinzugefuegt' : ''}.`);
        }
      }
      let result = stored;
      if (prune) {
        // API-Key gewechselt: Geräte, die nicht zum neuen Konto gehören, vollständig entfernen
        const removedNames = [];
        result = stored.filter((rec) => {
          if (seen.has(rec.id)) return true;
          for (const d of devices.getByGoveeId(rec.id)) {
            if (d.alreadyIncluded && !d.excluded) removedNames.push(d.friendlyName);
            devices.remove(d.deviceId);
          }
          log.info(`Govee: Geraet "${rec.name}" gehoert nicht zum neuen Konto > entfernt.`);
          return false;
        });
        if (removedNames.length) {
          this._notify?.localized(
            'notification.remove.title', 'notification.remove.message',
            { names: removedNames.join(', ') }, 'WARNING', { id: MSG_ID_REMOVE_HINT },
          );
        }
      } else {
        for (const rec of stored) {
          if (!seen.has(rec.id) && rec.available !== false) {
            rec.available = false;
            log.warn(`Govee: Geraet "${rec.name}" ist nicht mehr im Account vorhanden.`);
          }
        }
      }

      devicesStore.saveGoveeDevices(result);
      log.info(`Govee: ${list.length} Geraet(e) im Account, ${newCount} neu, ${autoAdded} automatisch hinzugefuegt.`);
      return { newCount, autoAdded };
    })().finally(() => { this._api.refreshing = null; });

    return this._api.refreshing;
  }

  /**
   * Cloud-Fehler auswerten und in der Homematic IP App melden.
   * Benachrichtigt wird nur beim Wechsel in einen Fehlerzustand, nicht bei
   * jedem erneuten Fehlschlag (keine Mitteilungsflut während eines Ausfalls).
   */
  _handleApiError(err) {
    if (err.isRateLimit) {
      log.warn('Govee: Anfragelimit erreicht (HTTP 429).');
      if (!this._api.rateLimited) {
        this._api.rateLimited = true;
        this._notify?.localized('notification.ratelimit.title', 'notification.ratelimit.message', {}, 'WARNING', { id: MSG_ID_RATE_LIMIT });
        this._pushConfigTemplate();
      }
      return;
    }
    const state = err.isAuthError ? 'auth' : 'network';
    log.warn(`Govee-API-Fehler (${state}): ${err.message}`);
    if (this._api.error === state) return;
    this._api.ok    = false;
    this._api.error = state;
    const key = err.isAuthError ? 'notification.api.auth' : 'notification.api.unavailable';
    this._notify?.localized(`${key}.title`, `${key}.message`, { error: err.message }, 'ERROR', { id: MSG_ID_API_ERROR });
    this._pushConfigTemplate();
  }

  /** Erfolgreicher Cloud-Request: Fehlerzustand aufheben und Mitteilung entfernen. */
  _markApiOk() {
    const hadError = this._api.error || this._api.rateLimited;
    this._api.ok          = true;
    this._api.error       = null;
    this._api.rateLimited = false;
    if (hadError) {
      log.info('Govee-Cloud wieder erreichbar.');
      this._notify?.dismiss(MSG_ID_API_ERROR);
      this._notify?.dismiss(MSG_ID_RATE_LIMIT);
      this._pushConfigTemplate();
    }
  }

  /** Hintergrund-Refresh der Geräteliste (Auto-Add neuer Geräte). */
  _startListRefresh() {
    this._stopListRefresh();
    this._listTimer = setInterval(async () => {
      try {
        const { autoAdded } = await this._refreshGoveeDevices();
        if (autoAdded > 0) {
          const { added } = this._syncHcuDevices();
          if (added > 0) this._triggerRediscover();
          this._restartPollingIfNeeded();
        }
      } catch { /* bereits geloggt */ }
    }, DEVICE_LIST_REFRESH_MS);
  }

  _stopListRefresh() {
    if (this._listTimer) {
      clearInterval(this._listTimer);
      this._listTimer = null;
    }
  }

  /**
   * Gleicht die HCU-Geräte mit den Haken in govee.json ab.
   *   - Haken gesetzt  > Kanäle anlegen; in der HCU gelöschte Kanäle werden
   *                      zum erneuten Melden freigegeben (Reinklusion)
   *   - Haken entfernt > HCU-Geräte entfernen; waren sie bereits in der HCU,
   *                      erscheint ein Hinweis in der App
   *
   * @param {object} [opts]
   * @param {boolean} [opts.reinclude] – in der HCU gelöschte Geräte wieder melden
   * @returns {{added:number, removedNames:string[]}}
   */
  _syncHcuDevices({ reinclude = false } = {}) {
    let added = 0;
    const removedNames = [];

    for (const g of this._loadGovee()) {
      const existing = devices.getByGoveeId(g.id);

      if (g.addToHcu && g.available !== false) {
        const channels = mapping.buildChannels(g);
        const wanted   = new Set(channels.map(c => devices.makeDeviceId(g.id, c.channel)));

        for (const ch of channels) {
          const id     = devices.makeDeviceId(g.id, ch.channel);
          const before = devices.getById(id);
          const dev    = devices.ensure(g, ch, this._channelName(g, ch.channel));
          if (!before) added++;
          if (reinclude && dev.excluded) {
            devices.setFlags([id], { excluded: false, alreadyIncluded: false });
            added++;
            log.info(`Reinklusion: ${id} wird erneut an die HCU gemeldet.`);
          }
        }
        // Kanäle, die es nicht mehr gibt (Capabilities geändert)
        for (const d of existing) {
          if (!wanted.has(d.deviceId)) {
            if (d.alreadyIncluded && !d.excluded) removedNames.push(d.friendlyName);
            devices.remove(d.deviceId);
          }
        }
      } else if (!g.addToHcu) {
        for (const d of existing) {
          if (d.alreadyIncluded && !d.excluded) removedNames.push(d.friendlyName);
          devices.remove(d.deviceId);
        }
      }
    }

    if (removedNames.length) {
      this._notify?.localized(
        'notification.remove.title',
        'notification.remove.message',
        { names: removedNames.join(', ') },
        'WARNING',
        { id: MSG_ID_REMOVE_HINT },
      );
    }
    return { added, removedNames };
  }

  _channelName(g, channel) {
    if (channel === 'main') return g.name;
    const m = channel.match(/^socket(\d+)$/);
    if (m) return `${g.name} ${t(this._lang, 'channel.socket').replace('{n}', m[1])}`;
    return `${g.name} ${t(this._lang, `channel.${channel}`)}`;
  }

  // ---------------------------------------------------------------------------
  //  Polling
  // ---------------------------------------------------------------------------

  /** Govee-Geräte, deren Zustand abgefragt werden muss (mind. ein aktiver Kanal). */
  _pollTargets() {
    const ids = new Set(devices.getActive().map(d => d.goveeId));
    return this._loadGovee().filter(g => ids.has(g.id) && g.available !== false);
  }

  /** Geräte, die über die Cloud abgefragt werden (alles außer lokal erreichbaren Lampen). */
  _cloudPollTargets() {
    return this._pollTargets().filter(g => !this._isLan(g));
  }

  /** Minimales Intervall (s), damit das Polling im Tageskontingent bleibt. */
  _minPollInterval(count = this._cloudPollTargets().length) {
    if (count === 0) return 0;
    return Math.ceil((count * 86400) / (govee.DAILY_REQUEST_LIMIT * POLL_BUDGET_SHARE));
  }

  _effectivePollInterval() {
    return Math.max(this._config.pollInterval, this._minPollInterval());
  }

  _startPolling() {
    this._stopPolling();
    if (!this._config.apiKey) return;
    const interval = this._effectivePollInterval();
    this._currentPollInterval = interval;
    log.info(`Cloud-Polling gestartet: alle ${interval}s (${this._cloudPollTargets().length} Geraet(e) ueber die Cloud).`);
    const tick = async () => {
      try { await this._pollAllDevices({ scope: 'cloud' }); }
      catch (err) { log.warn('Polling-Fehler:', err.message); }
      this._pollTimer = setTimeout(tick, this._effectivePollInterval() * 1000);
    };
    this._pollTimer = setTimeout(tick, interval * 1000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _restartPollingIfNeeded() {
    if (this._currentPollInterval !== this._effectivePollInterval()) this._startPolling();
  }

  /**
   * Fragt den Zustand der Govee-Geräte ab und sendet STATUS_EVENTs.
   * Lokal erreichbare Lampen werden über die LAN-API gelesen (kein Limit),
   * alle anderen über die Cloud.
   *
   * @param {object}   [opts]
   * @param {boolean}  [opts.force]        – STATUS_EVENT auch ohne Änderung senden
   * @param {string[]} [opts.onlyGoveeIds] – nur diese Govee-Geräte abfragen
   * @param {'all'|'cloud'|'lan'} [opts.scope] – 'cloud'/'lan' = periodische Zyklen
   */
  async _pollAllDevices({ force = false, onlyGoveeIds = null, scope = 'all' } = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._config.apiKey) return;
    const busyFlag = scope === 'lan' ? '_lanPolling' : '_polling';
    const periodic = !onlyGoveeIds;
    if (periodic && this[busyFlag]) return;
    if (periodic) this[busyFlag] = true;

    try {
      let targets = this._pollTargets();
      if (onlyGoveeIds)      targets = targets.filter(g => onlyGoveeIds.includes(g.id));
      if (scope === 'lan')   targets = targets.filter(g => this._isLan(g));
      if (scope === 'cloud') targets = targets.filter(g => !this._isLan(g));

      let cloudDown = false;
      for (const g of targets) {
        const graceUntil = this._controlGraceUntil.get(g.id);
        if (graceUntil && Date.now() < graceUntil) {
          log.debug(`Poll: ${g.name} in Steuerungs-Schonfrist – uebersprungen.`);
          continue;
        }
        if (graceUntil) this._controlGraceUntil.delete(g.id);

        // --- lokal (LAN-API) ---
        if (this._isLan(g)) {
          const data = await this._lan.readStatus(g.id);
          if (data) {
            this._applyState(g, mapping.lanStatusToStateCaps(data, g), force, `LAN ${JSON.stringify(data)}`);
            continue;
          }
          if (scope === 'lan') continue;   // nächster LAN-Zyklus bzw. Cloud nach 3 Fehlversuchen
        }

        // --- Cloud ---
        if (cloudDown) { if (force) this._sendStoredStates(g.id, { unreach: true }); continue; }
        let stateCaps;
        try {
          stateCaps = await govee.getState(this._config.apiKey, g.sku, g.id);
          this._markApiOk();
        } catch (err) {
          if (err.isRateLimit || err.isAuthError || err.isConnectionError) {
            // Cloud-Problem betrifft alle Cloud-Geräte > melden, keine weiteren Cloud-Abfragen
            this._handleApiError(err);
            cloudDown = true;
          } else {
            log.debug(`Poll: ${g.name} nicht abrufbar: ${err.message}`);
          }
          if (force) this._sendStoredStates(g.id, { unreach: true });
          continue;
        }
        this._applyState(g, stateCaps, force);
      }
    } finally {
      if (periodic) this[busyFlag] = false;
    }
  }

  /** Übernimmt einen gelesenen Zustand in alle HCU-Geräte eines Govee-Geräts. */
  _applyState(g, stateCaps, force = false, source = 'Cloud') {
    for (const dev of devices.getByGoveeId(g.id)) {
      if (!dev.alreadyIncluded || dev.excluded) continue;
      let live = mapping.stateToFeatures(dev, stateCaps, g, { sensorUnit: this._config.sensorUnit });
      if (!live.length) continue;

      // Ausgeschaltete Leuchte: nur switchState/maintenance senden, sonst
      // kann die HCU Helligkeits-/Farbwerte als "an" interpretieren.
      const sw = live.find(f => f.type === 'switchState');
      if (dev.deviceType === 'LIGHT' && sw && sw.on === false) {
        live = live.filter(f => f.type === 'switchState' || f.type === 'maintenance');
      }

      if (!force && !hasChanges(dev.features, live)) continue;
      devices.mergeFeatures(dev.deviceId, live);
      this._sendStatusEvent(dev.deviceId, live);
      if (dev.deviceType === 'LIGHT') {
        log.info(`STATUS_EVENT ${dev.friendlyName}: ${describeLight(devices.statusFeatures(live))} (Quelle: ${source})`);
      } else {
        log.debug(`Poll: STATUS_EVENT fuer ${dev.deviceId}.`);
      }
    }
  }

  /** Sendet gespeicherte Zustände (Fallback), optional mit unreach-Flag. */
  _sendStoredStates(goveeId, { unreach = false } = {}) {
    for (const dev of devices.getByGoveeId(goveeId)) {
      if (!dev.alreadyIncluded || dev.excluded) continue;
      const features = dev.features.map(f => (f.type === 'maintenance' ? { ...f, unreach } : f));
      this._sendStatusEvent(dev.deviceId, features);
    }
  }

  // ---------------------------------------------------------------------------
  //  Einstellungsseite (CONFIG_TEMPLATE / CONFIG_UPDATE)
  // ---------------------------------------------------------------------------

  _handleConfigTemplateRequest(message) {
    this._lang = message.body?.languageCode ?? message.body?.language ?? this._lang;
    log.info(`CONFIG_TEMPLATE_REQUEST (${this._lang}) > sende Konfigurationsvorlage.`);
    this._reply(message, 'CONFIG_TEMPLATE_RESPONSE', this._buildTemplate());

    // Geräteliste im Hintergrund aktualisieren und Seite ggf. neu senden
    if (this._config.apiKey && Date.now() - this._api.lastListAt > DEVICE_LIST_MAX_AGE_MS) {
      this._refreshGoveeDevices()
        .then(({ newCount, autoAdded }) => {
          if (autoAdded > 0) {
            const { added } = this._syncHcuDevices();
            if (added > 0) this._triggerRediscover();
          }
          if (newCount > 0) this._pushConfigTemplate();
        })
        .catch(() => this._pushConfigTemplate());
    }
  }

  async _handleConfigUpdateRequest(message) {
    const props = message.body?.properties ?? {};
    this._lang  = message.body?.languageCode ?? this._lang;
    log.info('CONFIG_UPDATE_REQUEST empfangen.');

    // --- Backup / Restore (Dropdown > backupMode/restoreMode) ---
    const actionValue  = props.backup_restore_action;
    const backupFields = {};
    if (actionValue !== undefined && actionValue !== null) {
      for (const lang of ['de', 'en']) {
        if (actionValue === t(lang, 'settings.backup_restore.action.backup'))  backupFields.backupMode  = true;
        if (actionValue === t(lang, 'settings.backup_restore.action.restore')) backupFields.restoreMode = true;
      }
    }
    if (this._backupManager.handleConfigUpdate(backupFields)) {
      this._pushConfigTemplate();
      this._reply(message, 'CONFIG_UPDATE_RESPONSE', { status: 'APPLIED' });
      return;
    }

    // --- Allgemeine Einstellungen ---
    // Auto-Add muss vor dem API-Key übernommen werden, damit beim ersten
    // Verbinden bereits alle Geräte automatisch hinzugefügt werden.
    if (props.autoAddNewDevices !== undefined) {
      this._config.autoAddNewDevices = toBool(props.autoAddNewDevices);
    }
    if (props.pollInterval !== undefined) {
      this._config.pollInterval = this._pollIntervalFromDisplay(String(props.pollInterval));
    }
    if (props.sensorUnit !== undefined) {
      const v = String(props.sensorUnit);
      this._config.sensorUnit = (v === t('de', 'settings.sensorunit.fahrenheit') || v === t('en', 'settings.sensorunit.fahrenheit')) ? 'F' : 'C';
    }

    const lanWas = this._config.lanEnabled !== false;
    if (props.lanEnabled !== undefined) this._config.lanEnabled = toBool(props.lanEnabled);

    const newKey     = typeof props.apiKey === 'string' ? props.apiKey.trim() : '';
    const keyChanged = newKey !== '' && newKey !== this._config.apiKey;
    if (keyChanged) {
      this._config.apiKey = newKey;
      this._api = { ok: null, error: null, lastListAt: 0, refreshing: null };
      log.info('Govee-API-Key geaendert.');
    }
    configStore.save(this._config);

    // --- Haken je Gerät übernehmen ---
    const stored = this._loadGovee();
    let checkboxChanged = false;
    for (const g of stored) {
      const key = `${this._groupId(g)}_add`;
      if (props[key] === undefined) continue;
      const val = toBool(props[key]);
      if (g.addToHcu !== val) {
        g.addToHcu = val;
        checkboxChanged = true;
        log.info(`Govee: "${g.name}" ${val ? 'wird hinzugefuegt' : 'wird nicht mehr bedient'}.`);
      }
    }
    if (checkboxChanged) devicesStore.saveGoveeDevices(stored);

    // --- Geräteliste laden (bei neuem Key immer, sonst wenn veraltet) ---
    let feedback = null;
    let status   = 'APPLIED';
    if (this._config.apiKey && (keyChanged || Date.now() - this._api.lastListAt > DEVICE_LIST_MAX_AGE_MS)) {
      try {
        await this._refreshGoveeDevices({ prune: keyChanged });
      } catch (err) {
        status   = keyChanged ? 'FAILED' : 'APPLIED';
        feedback = t(this._lang, err.isAuthError ? 'feedback.api.auth' : 'feedback.api.unavailable');
      }
    }

    // --- HCU-Geräte abgleichen, Reinklusion gelöschter Geräte ---
    this._syncHcuDevices({ reinclude: true });
    this._requestReinclude('Einstellungen gespeichert');

    if (keyChanged) {
      this._sendPluginState(uuidv4());
      this._startListRefresh();
    }
    this._startPolling();

    // Lokale Steuerung: bei Änderung starten/stoppen, sonst neu scannen
    if ((this._config.lanEnabled !== false) !== lanWas) {
      this._stopLan();
      await this._startLan();
    } else {
      this._lanScan();
    }

    this._pushConfigTemplate();
    this._reply(message, 'CONFIG_UPDATE_RESPONSE', feedback ? { status, message: feedback } : { status });
  }

  _pushConfigTemplate() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._send({ id: uuidv4(), pluginId: this.pluginId, type: 'CONFIG_TEMPLATE_RESPONSE', body: this._buildTemplate() });
  }

  _groupId(g) { return `dev_${devices.goveeKey(g.id)}`; }

  /** Baut groups + properties der Einstellungsseite. */
  _buildTemplate() {
    const lang       = this._lang;
    const groups     = {};
    const properties = {};
    const hasKey     = Boolean(this._config.apiKey);

    // --- Allgemein ---
    groups.general = {
      friendlyName: t(lang, 'group.general.name'),
      description:  t(lang, hasKey ? 'group.general.description' : 'group.general.description.nokey'),
      order:        1,
    };

    properties.apiKey = {
      friendlyName: t(lang, 'settings.apikey.label'),
      description:  t(lang, 'settings.apikey.description'),
      dataType:     'PASSWORD',
      groupId:      'general',
      order:        1,
      defaultValue: '',
      currentValue: this._config.apiKey ?? '',
    };
    properties.apiStatus = {
      friendlyName: t(lang, 'settings.apistatus.label'),
      description:  t(lang, 'settings.apistatus.description'),
      dataType:     'READONLY',
      groupId:      'general',
      order:        2,
      currentValue: this._apiStatusText(),
    };
    properties.autoAddNewDevices = {
      friendlyName: t(lang, 'settings.autoadd.label'),
      description:  t(lang, 'settings.autoadd.description'),
      dataType:     'BOOLEAN',
      groupId:      'general',
      order:        3,
      defaultValue: false,
      currentValue: Boolean(this._config.autoAddNewDevices),
    };

    const minPoll = this._minPollInterval();
    properties.pollInterval = {
      friendlyName: t(lang, 'settings.pollinterval.label'),
      description:  t(lang, 'settings.pollinterval.description')
        + (minPoll > this._config.pollInterval
          ? ' ' + t(lang, 'settings.pollinterval.limited').replace('{seconds}', String(minPoll))
          : ''),
      dataType:     'ENUM',
      groupId:      'general',
      order:        4,
      defaultValue: t(lang, 'settings.pollinterval.5min'),
      currentValue: t(lang, `settings.pollinterval.${this._pollIntervalKey()}`),
      values:       Object.keys(POLL_OPTIONS).map(k => t(lang, `settings.pollinterval.${k}`)),
    };
    properties.sensorUnit = {
      friendlyName: t(lang, 'settings.sensorunit.label'),
      description:  t(lang, 'settings.sensorunit.description'),
      dataType:     'ENUM',
      groupId:      'general',
      order:        5,
      defaultValue: t(lang, 'settings.sensorunit.celsius'),
      currentValue: t(lang, this._config.sensorUnit === 'F' ? 'settings.sensorunit.fahrenheit' : 'settings.sensorunit.celsius'),
      values:       [t(lang, 'settings.sensorunit.celsius'), t(lang, 'settings.sensorunit.fahrenheit')],
    };

    // --- Lokale Steuerung (Govee LAN-API) ---
    properties.lanEnabled = {
      friendlyName: t(lang, 'settings.lan.label'),
      description:  t(lang, 'settings.lan.description'),
      dataType:     'BOOLEAN',
      groupId:      'general',
      order:        6,
      defaultValue: true,
      currentValue: this._config.lanEnabled !== false,
    };
    properties.lanStatus = {
      friendlyName: t(lang, 'settings.lan.status.label'),
      description:  t(lang, 'settings.lan.status.description'),
      dataType:     'READONLY',
      groupId:      'general',
      order:        7,
      currentValue: this._lanStatusText(),
    };

    // --- Ein Tab je Govee-Gerät ---
    const goveeList = hasKey
      ? this._loadGovee().slice().sort((a, b) => String(a.name).localeCompare(String(b.name), lang))
      : [];

    goveeList.forEach((g, i) => {
      const gid      = this._groupId(g);
      const channels = mapping.buildChannels(g);
      const typeName = t(lang, `govee.type.${GOVEE_TYPE_KEYS[g.type] ?? 'other'}`);

      groups[gid] = {
        friendlyName: g.name,
        description:  t(lang, 'group.device.description').replace('{sku}', g.sku ?? '-').replace('{type}', typeName),
        order:        10 + i,
      };

      if (channels.length === 0) {
        properties[`${gid}_unsupported`] = {
          friendlyName: t(lang, 'device.unsupported.label'),
          description:  t(lang, 'device.unsupported.description'),
          dataType:     'READONLY',
          groupId:      gid,
          order:        1,
          currentValue: t(lang, 'device.unsupported.value'),
        };
        return;
      }

      properties[`${gid}_add`] = {
        friendlyName: t(lang, 'device.add.label'),
        description:  t(lang, 'device.add.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        1,
        defaultValue: false,
        currentValue: Boolean(g.addToHcu),
      };
      properties[`${gid}_mapping`] = {
        friendlyName: t(lang, 'device.mapping.label'),
        description:  t(lang, 'device.mapping.description'),
        dataType:     'READONLY',
        groupId:      gid,
        order:        2,
        currentValue: channels.map(c => t(lang, `hmip.type.${c.deviceType}`)).join(' + '),
      };
    });

    // --- Backup & Restore (eine Gruppe, Dropdown-Steuerung) ---
    this._addBackupTemplate(groups, properties);

    // --- Info ---
    groups.info = {
      friendlyName: t(lang, 'group.info.name'),
      description:  t(lang, 'group.info.description'),
      order:        999,
    };
    properties.apiKeyInfo = {
      friendlyName: t(lang, 'settings.apikeyinfo.label'),
      description:  t(lang, 'settings.apikeyinfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        1,
      defaultValue: t(lang, 'settings.apikeyinfo.linktitle'),
      currentValue: 'https://developer.govee.com/reference/apply-you-govee-api-key',
    };
    properties.copyrightInfo = {
      friendlyName: t(lang, 'settings.copyrightinfo.label'),
      description:  t(lang, 'settings.copyrightinfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        2,
      defaultValue: t(lang, 'settings.copyrightinfo.linktitle'),
      currentValue: 'https://www.govee.com/',
    };
    properties.pluginInfo = {
      friendlyName: t(lang, 'settings.pluginInfo.label'),
      description:  t(lang, 'settings.pluginInfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        3,
      defaultValue: t(lang, 'settings.pluginInfo.linktitle'),
      currentValue: REPO_URL,
    };

    return { groups, properties };
  }

  _apiStatusText() {
    const lang = this._lang;
    if (!this._config.apiKey)          return t(lang, 'settings.apistatus.nokey');
    if (this._api.error === 'auth')    return t(lang, 'settings.apistatus.auth');
    if (this._api.error === 'network') return t(lang, 'settings.apistatus.network');
    if (this._api.ok) {
      const count = this._loadGovee().filter(g => g.available !== false).length;
      return t(lang, 'settings.apistatus.ok').replace('{count}', String(count));
    }
    return t(lang, 'settings.apistatus.pending');
  }


  _addBackupTemplate(groups, properties) {
    const lang       = this._lang;
    const safeLang   = ['de', 'en'].includes(lang) ? lang : 'de';
    const backupHost = this._backupHost;
    const [backupGroup, restoreGroup] = this._backupManager.getConfigGroups();
    const backupActive  = backupGroup.fields.some(f => f.type !== 'BOOLEAN');
    const restoreActive = restoreGroup.fields.some(f => f.type !== 'BOOLEAN');

    const resolve = (s) => String(s ?? '')
      .replace(/\{\{hostname\}\}/g, backupHost)
      .replace(/\{\{lang\}\}/g, safeLang);

    let description = t(lang, 'group.backup_restore.description');
    if (backupActive)  description = resolve(backupGroup.description?.[safeLang]);
    if (restoreActive) description = resolve(restoreGroup.description?.[safeLang]);

    groups.backup_restore = {
      friendlyName: t(lang, 'group.backup_restore.name'),
      description,
      order:        997,
    };

    if (backupActive || restoreActive) {
      const activeFields = backupActive ? backupGroup.fields : restoreGroup.fields;
      activeFields.forEach((field, i) => {
        if (field.type === 'LINK') {
          properties[`backup_restore_${field.id}`] = {
            friendlyName: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            description:  field.label?.[safeLang] ?? '',
            dataType:     'WEBLINK',
            groupId:      'backup_restore',
            order:        i + 2,
            defaultValue: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            currentValue: resolve(field.url),
          };
        } else if (field.type === 'STRING') {
          const value = field.readOnly ? resolve(field.value) : (field.value ?? '');
          properties[`backup_restore_${field.id}`] = {
            friendlyName: field.label?.[safeLang] ?? '',
            description:  '',
            dataType:     'STRING',
            groupId:      'backup_restore',
            order:        i + 2,
            defaultValue: value,
            currentValue: value,
          };
        }
      });
    } else {
      properties.backup_restore_action = {
        friendlyName: t(lang, 'settings.backup_restore.action.label'),
        description:  t(lang, 'settings.backup_restore.action.description'),
        dataType:     'ENUM',
        groupId:      'backup_restore',
        order:        1,
        defaultValue: t(lang, 'settings.backup_restore.action.disabled'),
        currentValue: t(lang, 'settings.backup_restore.action.disabled'),
        values: [
          t(lang, 'settings.backup_restore.action.disabled'),
          t(lang, 'settings.backup_restore.action.backup'),
          t(lang, 'settings.backup_restore.action.restore'),
        ],
      };
    }
  }

  _pollIntervalKey() {
    const entry = Object.entries(POLL_OPTIONS).find(([, s]) => s === this._config.pollInterval);
    return entry ? entry[0] : '5min';
  }

  _pollIntervalFromDisplay(displayValue) {
    for (const [key, secs] of Object.entries(POLL_OPTIONS)) {
      for (const lang of ['de', 'en']) {
        if (t(lang, `settings.pollinterval.${key}`) === displayValue) return secs;
      }
    }
    const parsed = parseInt(displayValue, 10);
    return Number.isFinite(parsed) && parsed >= 60 ? parsed : configStore.DEFAULTS.pollInterval;
  }

  // ---------------------------------------------------------------------------
  //  Lokale Steuerung (Govee LAN-API)
  // ---------------------------------------------------------------------------

  /** SYSTEM_INFO_REQUEST > liefert u. a. die LAN-IP der HCU. */
  _requestSystemInfo(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const id = uuidv4();
      const timer = setTimeout(() => { this._pendingSystemInfo.delete(id); resolve(null); }, timeoutMs);
      this._pendingSystemInfo.set(id, (body) => { clearTimeout(timer); resolve(body); });
      this._send({ id, pluginId: this.pluginId, type: 'SYSTEM_INFO_REQUEST', body: {} });
    });
  }

  /** true, wenn das Govee-Gerät aktuell lokal (LAN-API) erreichbar ist. */
  _isLan(g) {
    return this._config.lanEnabled !== false
      && this._lan.ready
      && Boolean(this._lan.lookup(g.id))
      && mapping.isLanCapable(g);
  }

  /** Startet die lokale Steuerung: Port binden, Subnetz scannen, Zyklen starten. */
  async _startLan() {
    if (this._config.lanEnabled === false) return;
    if (!(await this._lan.start())) { this._pushConfigTemplate(); return; }

    const info = await this._requestSystemInfo();
    if (info?.ipAddress) this._hcuIp = info.ipAddress;
    if (!this._hcuIp) log.warn('Govee LAN: HCU-IP unbekannt > kein Scan moeglich.');

    this._lanScan();
    clearInterval(this._lanScanTimer);
    this._lanScanTimer = setInterval(() => this._lanScan(), LAN_SCAN_MS);

    clearTimeout(this._lanPollTimer);
    const tick = async () => {
      try { await this._pollAllDevices({ scope: 'lan' }); }
      catch (err) { log.warn('Govee LAN: Polling-Fehler:', err.message); }
      if (this._lan.ready) this._lanPollTimer = setTimeout(tick, LAN_POLL_MS);
    };
    this._lanPollTimer = setTimeout(tick, LAN_POLL_MS);
  }

  _stopLan() {
    clearInterval(this._lanScanTimer);
    clearTimeout(this._lanPollTimer);
    this._lanScanTimer = null;
    this._lanPollTimer = null;
    const had = this._lan.ready;
    this._lan.stop();
    if (had) this._onLanChange();
  }

  _lanScan() {
    if (!this._lan.ready || !this._hcuIp) return;
    this._lan.scan(this._hcuIp).catch(err => log.debug('Govee LAN: Scan-Fehler:', err.message));
  }

  /** Eine Lampe ist lokal erreichbar geworden oder ausgefallen. */
  _onLanChange() {
    // Cloud-Intervall hängt von der Zahl der Cloud-Geräte ab
    if (this._pollTimer) this._restartPollingIfNeeded();
    // Ausgefallene Lampe: zeitnah neu suchen (IP-Wechsel) – höchstens 1x pro Minute
    if (this._lan.ready && Date.now() - (this._lastLanRescan ?? 0) > 60_000) {
      this._lastLanRescan = Date.now();
      setTimeout(() => this._lanScan(), 2000);
    }
    this._pushConfigTemplate();
  }

  /**
   * Führt Steuerbefehle lokal aus und prüft per Statusabfrage, ob die Lampe
   * antwortet (UDP kennt keine Quittung).
   * @returns {Promise<boolean>} false > Aufrufer nutzt die Cloud
   */
  async _lanControl(g, cmds) {
    const lanCmds = mapping.commandsToLan(cmds, g);
    if (!lanCmds) return false;
    for (let i = 0; i < lanCmds.length; i++) {
      if (i > 0) await sleep(LAN_CMD_GAP_MS);
      if (!(await this._lan.command(g.id, lanCmds[i].cmd, lanCmds[i].data))) return false;
    }
    await sleep(LAN_VERIFY_MS);
    return Boolean(await this._lan.readStatus(g.id));
  }

  _lanStatusText() {
    const lang = this._lang;
    if (this._config.lanEnabled === false) return t(lang, 'settings.lan.status.disabled');
    if (!this._lan.ready) {
      return this._lan.bindError
        ? t(lang, 'settings.lan.status.portbusy')
        : t(lang, 'settings.lan.status.starting');
    }
    const local = this._loadGovee().filter(g => this._isLan(g));
    if (!local.length) return t(lang, 'settings.lan.status.none');
    const names = local.map(g => `${g.name} (${this._lan.lookup(g.id).ip})`).join(', ');
    return t(lang, 'settings.lan.status.ok').replace('{count}', String(local.length)).replace('{names}', names);
  }

  // ---------------------------------------------------------------------------
  //  Reconnect mit Exponential Backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    log.info(`Wiederverbindung in ${this._reconnectDelay / 1000}s ...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(Math.round(this._reconnectDelay * RECONNECT_FACTOR), RECONNECT_MAX_MS);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

function toBool(v) { return v === true || v === 'true'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


/** Kurzbeschreibung des Lichtzustands für das Log, z. B. "an, 100 %, Farbe 272°/100 %". */
function describeLight(features) {
  const f = (t) => features.find(x => x.type === t);
  const parts = [];
  const sw = f('switchState');
  if (sw) parts.push(sw.on ? 'an' : 'aus');
  const dim = f('dimming');
  if (dim) parts.push(`${Math.round(dim.dimLevel * 100)} %`);
  const color = f('color');
  const ct    = f('colorTemperature');
  if (color) parts.push(Number(color.hue) >= 361 ? 'Farbe: ignorieren' : `Farbe ${color.hue}°/${Math.round(color.saturationLevel * 100)} %`);
  if (ct)    parts.push(Number(ct.colorTemperature) >= 10050 ? 'Weiß: ignorieren' : `Weiß ${ct.colorTemperature} K`);
  return parts.join(', ') || '-';
}

/** Vergleicht Live-Features mit gespeicherten Features (alle Attribute außer type). */
function hasChanges(stored, live) {
  for (const lf of live) {
    const sf = stored.find(f => f.type === lf.type);
    if (!sf) return true;
    for (const [k, v] of Object.entries(lf)) {
      if (k !== 'type' && sf[k] !== v) return true;
    }
  }
  return false;
}

module.exports = Plugin;
