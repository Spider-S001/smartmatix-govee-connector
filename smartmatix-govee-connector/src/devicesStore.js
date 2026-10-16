'use strict';

/**
 * devicesStore.js
 *
 * Liest und schreibt die HCU-Geräte (devices.json) sowie den Govee-
 * Gerätecache (govee.json). Die Dateien liegen im Arbeitsverzeichnis des
 * Plugins: /data
 *
 * Format der devices.json (ein Eintrag je HCU-Gerät / Kanal):
 * {
 *   "govee-528bd4adfc455dfe-main": {
 *     "deviceType":      "LIGHT",
 *     "deviceId":        "govee-528bd4adfc455dfe-main",
 *     "friendlyName":    "Wohnzimmer Strip",
 *     "modelType":       "GoveeLight",
 *     "features":        [ { "type": "switchState", "on": false }, ... ],
 *     "goveeId":         "52:8B:D4:AD:FC:45:5D:FE",
 *     "channel":         "main",
 *     "alreadyIncluded": true,    // per DISCOVER_RESPONSE an die HCU gemeldet
 *     "excluded":        false    // in der HCU gelöscht (EXCLUSION_EVENT)
 *   }
 * }
 *
 * Format der govee.json (ein Eintrag je Govee-Gerät des Accounts):
 * [
 *   {
 *     "id":           "52:8B:D4:AD:FC:45:5D:FE",   // Govee "device"
 *     "sku":          "H6008",
 *     "name":         "Wohnzimmer Strip",
 *     "type":         "devices.types.light",
 *     "capabilities": [ ... ],                     // aus /user/devices
 *     "addToHcu":     true,                        // Haken in den Einstellungen
 *     "available":    true,                        // noch im Govee-Account vorhanden
 *     "firstSeen":    "2026-09-22T18:00:00.000Z"
 *   }
 * ]
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const FILES = {
  devices: { file: 'devices.json', empty: () => ({}) },
  govee:   { file: 'govee.json',   empty: () => [] },
};

function filePath(type) {
  const def = FILES[type];
  if (!def) throw new Error(`devicesStore: Unbekannter Typ "${type}"`);
  return path.join(DATA_PATH, def.file);
}

/**
 * Liest eine JSON-Datei vom Dateisystem.
 * @param {'devices'|'govee'} type
 */
function load(type) {
  const fp = filePath(type);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw.trim() ? JSON.parse(raw) : FILES[type].empty();
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Fehler beim Lesen der ${FILES[type].file}:`, err.message);
    return FILES[type].empty();
  }
}

/**
 * Schreibt Daten als JSON in die Datei des angegebenen Typs.
 * @param {'devices'|'govee'} type
 * @param {object|Array}      data
 */
function save(type, data) {
  const fp = filePath(type);
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
    log.debug(`${FILES[type].file} gespeichert.`);
  } catch (err) {
    log.error(`Fehler beim Schreiben der ${FILES[type].file}:`, err.message);
  }
}

module.exports = {
  load,
  save,
  loadGoveeDevices: () => load('govee'),
  saveGoveeDevices: (list) => save('govee', list),
};
