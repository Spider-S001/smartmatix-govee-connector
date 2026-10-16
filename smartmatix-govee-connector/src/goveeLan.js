'use strict';

/**
 * goveeLan.js – Client für die Govee LAN-API (lokale Steuerung von Lampen)
 *
 * Protokoll (UDP, nur Lampen mit aktiviertem "LAN Control" in der Govee App):
 *   Plugin  > Gerät  UDP 4001   scan (Unicast an jede Adresse im Subnetz der HCU)
 *   Gerät   > Plugin UDP 4002   Antworten (immer an Port 4002 der Absender-IP)
 *   Plugin  > Gerät  UDP 4003   turn, brightness, colorwc, devStatus
 *
 * Besonderheit auf der HCU:
 *   Port 4002 wird über einen Proxy in den Container gereicht. Dabei geht die
 *   Absenderadresse verloren (alle Pakete kommen von der Container-IP).
 *     - scan-Antworten enthalten die Geräte-IP und -ID im Inhalt > kein Problem
 *     - devStatus-Antworten enthalten KEINE Geräteangabe > sie lassen sich nur
 *       über die Reihenfolge zuordnen. Deshalb wird immer nur EINE Lampe
 *       gleichzeitig abgefragt (Warteschlange) und auf deren Antwort gewartet.
 *
 * Multicast/mDNS wird nicht verwendet (auf der HCU nicht verfügbar).
 */

const dgram = require('dgram');
const log   = require('./logger');

const SCAN_PORT    = 4001;
const LISTEN_PORT  = 4002;
const CONTROL_PORT = 4003;

const SCAN_MSG = JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } });

const STATUS_TIMEOUT_MS = 1500;   // Wartezeit auf eine devStatus-Antwort
const DRAIN_AFTER_TIMEOUT_MS = 800; // nach Timeout verspätete Antworten verwerfen
const MAX_FAILURES      = 3;      // danach gilt die Lampe als lokal nicht erreichbar

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm  = (id) => String(id ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();

function isLanIPv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? '') && !/^(127\.|169\.254\.|0\.)/.test(ip);
}

class GoveeLanClient {
  /**
   * @param {object}   [opts]
   * @param {Function} [opts.onChange] – wird aufgerufen, wenn eine Lampe lokal
   *                                     erreichbar wird oder ausfällt
   */
  constructor({ onChange } = {}) {
    this._sock     = null;           // Port 4002: Empfang + Steuerbefehle
    this._scanSock = null;           // eigener Socket für den Subnetz-Scan (siehe scan())
    this._ready    = false;
    this.bindError = null;
    this._devices  = new Map();          // normierte Geräte-ID > { ip, sku, failures, lastSeen }
    this._queue    = Promise.resolve();  // serialisiert devStatus-Abfragen
    this._waiter   = null;               // resolve() der gerade laufenden devStatus-Abfrage
    this._onChange = onChange ?? (() => {});
  }

  get ready() { return this._ready; }

  /** Bindet UDP-Port 4002. @returns {Promise<boolean>} */
  async start() {
    if (this._ready) return true;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(LISTEN_PORT, '0.0.0.0', () => { sock.removeListener('error', reject); resolve(); });
      });
    } catch (err) {
      this.bindError = err.message;
      log.warn(`Govee LAN: UDP-Port ${LISTEN_PORT} nicht verfuegbar (${err.message}) > lokale Steuerung deaktiviert.`);
      try { sock.close(); } catch { /* ignore */ }
      return false;
    }
    sock.on('error', (err) => log.warn('Govee LAN: Socket-Fehler:', err.message));
    sock.on('message', (buf) => this._onPacket(buf));
    this._sock     = sock;
    this._ready    = true;
    this.bindError = null;
    log.info(`Govee LAN: UDP-Port ${LISTEN_PORT} gebunden.`);
    return true;
  }

  stop() {
    this._ready = false;
    try { this._sock?.close(); } catch { /* ignore */ }
    try { this._scanSock?.close(); } catch { /* ignore */ }
    this._sock = null;
    this._scanSock = null;
    this._devices.clear();
    if (this._waiter) { this._waiter(null); this._waiter = null; }
  }

  _onPacket(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8'))?.msg; } catch { return; }
    if (!msg) return;

    if (msg.cmd === 'scan' && msg.data?.device && isLanIPv4(msg.data.ip)) {
      const key  = norm(msg.data.device);
      const prev = this._devices.get(key);
      const wasActive = prev && prev.failures < MAX_FAILURES;
      this._devices.set(key, { ip: msg.data.ip, sku: msg.data.sku, failures: 0, lastSeen: Date.now() });
      if (!wasActive || prev.ip !== msg.data.ip) {
        log.info(`Govee LAN: Lampe ${msg.data.sku} (${msg.data.device}) lokal erreichbar unter ${msg.data.ip}.`);
        this._onChange();
      }
    } else if (msg.cmd === 'devStatus' && this._waiter) {
      const resolve = this._waiter;
      this._waiter = null;
      resolve(msg.data ?? {});
    }
    // devStatus ohne wartende Abfrage = verspätete Antwort > verwerfen
  }

  _send(text, port, ip) {
    return new Promise((resolve) => {
      if (!this._sock) return resolve(false);
      this._sock.send(text, port, ip, (err) => resolve(!err));
    });
  }

  /**
   * Unicast-Scan über das /24-Subnetz der HCU. Antworten treffen asynchron
   * auf Port 4002 ein (die Lampen antworten unabhängig vom Absender-Port
   * immer dorthin).
   *
   * Der Scan nutzt einen eigenen Socket: Pakete an nicht vergebene Adressen
   * können im Socket auf die Adressauflösung warten und würden sonst
   * Steuerbefehle und Statusabfragen auf dem Hauptsocket ausbremsen.
   */
  async scan(hcuIp) {
    if (!this._ready || !isLanIPv4(hcuIp) || this._scanning) return false;
    this._scanning = true;
    try {
      if (!this._scanSock) {
        this._scanSock = dgram.createSocket('udp4');
        this._scanSock.on('error', (err) => log.debug('Govee LAN: Scan-Socket-Fehler:', err.message));
      }
      const sock   = this._scanSock;
      const prefix = hcuIp.split('.').slice(0, 3).join('.');
      log.debug(`Govee LAN: Scan ${prefix}.1-254 ...`);
      for (let i = 1; i <= 254; i++) {
        sock.send(SCAN_MSG, SCAN_PORT, `${prefix}.${i}`, () => {});   // bewusst nicht abwarten
        if (i % 32 === 0) await sleep(20);
      }
      return true;
    } finally {
      this._scanning = false;
    }
  }

  /** Liefert den LAN-Eintrag einer Lampe, wenn sie lokal erreichbar ist. */
  lookup(goveeId) {
    const e = this._devices.get(norm(goveeId));
    return e && e.failures < MAX_FAILURES ? e : null;
  }

  /** Alle lokal erreichbaren Lampen: [{ id (normiert), ip, sku }] */
  active() {
    return [...this._devices.entries()]
      .filter(([, e]) => e.failures < MAX_FAILURES)
      .map(([id, e]) => ({ id, ip: e.ip, sku: e.sku }));
  }

  /**
   * Fragt den Status einer Lampe ab (serialisiert, siehe Dateikopf).
   * @returns {Promise<object|null>} { onOff, brightness, color:{r,g,b}, colorTemInKelvin } oder null
   */
  readStatus(goveeId) {
    const run = async () => {
      const entry = this.lookup(goveeId);
      if (!entry || !this._ready) return null;

      const data = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this._waiter === done) this._waiter = null;
          resolve(null);
        }, STATUS_TIMEOUT_MS);
        const done = (d) => { clearTimeout(timer); resolve(d); };
        this._waiter = done;
        this._send(JSON.stringify({ msg: { cmd: 'devStatus', data: {} } }), CONTROL_PORT, entry.ip);
      });

      if (data) {
        entry.failures = 0;
        entry.lastSeen = Date.now();
      } else {
        entry.failures++;
        log.debug(`Govee LAN: keine Status-Antwort von ${entry.ip} (${entry.failures}/${MAX_FAILURES}).`);
        if (entry.failures >= MAX_FAILURES) {
          log.warn(`Govee LAN: Lampe ${entry.sku} (${entry.ip}) lokal nicht mehr erreichbar > Cloud.`);
          this._onChange();
        }
        // verspätete Antwort nicht der nächsten Lampe zuordnen
        await sleep(DRAIN_AFTER_TIMEOUT_MS);
      }
      return data;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => null);
    return p;
  }

  /** Sendet einen Steuerbefehl ({ cmd, data }) an eine Lampe. */
  async command(goveeId, cmd, data) {
    const entry = this.lookup(goveeId);
    if (!entry || !this._ready) return false;
    log.info(`Govee LAN ${entry.ip}: ${cmd} ${JSON.stringify(data)}`);
    return this._send(JSON.stringify({ msg: { cmd, data } }), CONTROL_PORT, entry.ip);
  }
}

module.exports = { GoveeLanClient, LISTEN_PORT, MAX_FAILURES };
