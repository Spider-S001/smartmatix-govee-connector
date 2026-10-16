'use strict';

/**
 * goveeMapping.js – Übersetzung zwischen Govee-Capabilities und HmIP-Geräten
 *
 * Ein Govee-Gerät wird auf so wenige HmIP-Geräte ("Kanäle") wie möglich
 * abgebildet. Jeder Kanal ist ein eigenes Gerät in der HCU:
 *
 *   Kanal      HmIP-Typ                    Quelle (Govee)
 *   ---------  --------------------------  -------------------------------------------
 *   main       LIGHT                       Lampen/Boxen: powerSwitch, brightness,
 *                                          colorRgb, colorTemperatureK
 *   main       SWITCH                      alle anderen Geräte mit powerSwitch
 *                                          (Steckdosen, Heizer, Luftreiniger, Ventilator …)
 *   main       CLIMATE_SENSOR              Thermo-/Hygrometer ohne powerSwitch
 *   main       PARTICULATE_MATTER_SENSOR   reine Feinstaubsensoren ohne powerSwitch
 *   thermostat THERMOSTAT                  temperature_setting (Zieltemperatur),
 *                                          inkl. Ist-Temperatur/Feuchte, falls vorhanden
 *   pm         PARTICULATE_MATTER_SENSOR   PM2.5-Wert eines schaltbaren Geräts
 *                                          (inkl. Temperatur/Feuchte, falls noch frei)
 *   climate    CLIMATE_SENSOR              Temperatur/Feuchte eines schaltbaren Geräts,
 *                                          wenn sie in keinem anderen Kanal Platz hatten
 *   socketN    SWITCH                      Mehrfachsteckdosen: socketToggleN (ersetzt
 *                                          dann den main-Kanal)
 *
 * Alles, wofür es in HmIP kein Gegenstück gibt (Szenen, Modi, Lüfterstufen,
 * Segmentfarben, Musikmodus, Nachtlicht-Toggles, Zielfeuchte …), wird bewusst
 * weggelassen.
 */

const { DEVICE_TYPE_FEATURES } = require('../constants/feature_catalog');

const CAP = {
  ON_OFF:        'devices.capabilities.on_off',
  TOGGLE:        'devices.capabilities.toggle',
  RANGE:         'devices.capabilities.range',
  COLOR:         'devices.capabilities.color_setting',
  TEMP_SETTING:  'devices.capabilities.temperature_setting',
  PROPERTY:      'devices.capabilities.property',
  ONLINE:        'devices.capabilities.online',
};

const LIGHT_TYPES   = new Set(['devices.types.light']);
const LIGHTISH_TYPES = new Set(['devices.types.box']); // TV-Backlight-Boxen o. ä.

const PM25_REGEX   = /^(sensor)?pm2(\.|_)?5$/i;
const SOCKET_REGEX = /^socketToggle(\d+)$/;

// Spezialwerte der Connect API ("letzter Wert" / "ignorieren")
const HUE_IGNORE = 361;
const SAT_IGNORE = 1.01;
const CT_IGNORE  = 10100;
const LEVEL_SPECIAL_MIN = 1.005;   // dimLevel/saturationLevel >= 1.005 = Spezialwert
const CT_SPECIAL_MIN    = 10050;   // colorTemperature >= 10050 = Spezialwert

// ---------------------------------------------------------------------------
//  Capability-Helfer
// ---------------------------------------------------------------------------

function findCap(caps, type, instance) {
  return (caps ?? []).find(c => c.type === type && (instance instanceof RegExp ? instance.test(c.instance) : c.instance === instance)) ?? null;
}

function rangeOf(cap, defMin, defMax) {
  const r = cap?.parameters?.range;
  return {
    min: Number.isFinite(r?.min) ? r.min : defMin,
    max: Number.isFinite(r?.max) ? r.max : defMax,
  };
}

function targetTempCap(caps) {
  return findCap(caps, CAP.TEMP_SETTING, 'targetTemperature')
      ?? findCap(caps, CAP.TEMP_SETTING, 'sliderTemperature');
}

/** Analysiert die Capabilities eines Govee-Geräts. */
function analyze(goveeDevice) {
  const caps = goveeDevice.capabilities ?? [];
  const sockets = caps
    .filter(c => c.type === CAP.TOGGLE && SOCKET_REGEX.test(c.instance))
    .map(c => ({ instance: c.instance, index: Number(c.instance.match(SOCKET_REGEX)[1]) }))
    .sort((a, b) => a.index - b.index);

  const a = {
    power:      findCap(caps, CAP.ON_OFF, 'powerSwitch'),
    brightness: findCap(caps, CAP.RANGE, 'brightness'),
    rgb:        findCap(caps, CAP.COLOR, 'colorRgb'),
    ct:         findCap(caps, CAP.COLOR, 'colorTemperatureK'),
    target:     targetTempCap(caps),
    temp:       findCap(caps, CAP.PROPERTY, 'sensorTemperature'),
    hum:        findCap(caps, CAP.PROPERTY, 'sensorHumidity'),
    pm25:       findCap(caps, CAP.PROPERTY, PM25_REGEX),
    sockets,
  };
  a.isLight = LIGHT_TYPES.has(goveeDevice.type)
           || (LIGHTISH_TYPES.has(goveeDevice.type) && Boolean(a.brightness || a.rgb || a.ct));
  return a;
}

// ---------------------------------------------------------------------------
//  Kanäle (HmIP-Geräte) eines Govee-Geräts bestimmen
// ---------------------------------------------------------------------------

/**
 * Liefert die Kanal-Definitionen eines Govee-Geräts.
 * @returns {Array<{channel:string, deviceType:string, features:object[]}>}
 *          Leeres Array = Gerät wird nicht unterstützt.
 */
function buildChannels(goveeDevice) {
  const a        = analyze(goveeDevice);
  const channels = [];
  let tempFree   = Boolean(a.temp);
  let humFree    = Boolean(a.hum);
  let pmFree     = Boolean(a.pm25);

  const takeClimate = (features) => {
    if (tempFree) { features.push({ type: 'actualTemperature', actualTemperature: 20.0 }); tempFree = false; }
    if (humFree)  { features.push({ type: 'humidity', humidity: 50 });                     humFree  = false; }
  };
  const pmFeature = () => ({ type: 'particulateMassTwoPointFive', particulateMassConcentrationTwoPointFive: 0 });

  // Mehrfachsteckdose mit einzeln schaltbaren Dosen: die Dosen genügen,
  // ein zusätzlicher "Alle"-Schalter wäre redundant
  const socketsOnly = !a.isLight && a.sockets.length >= 2;

  // --- Hauptkanal ---
  if (a.power && !socketsOnly) {
    if (a.isLight) {
      const features = [{ type: 'switchState', on: false }];
      if (a.brightness) features.push({ type: 'dimming', dimLevel: 1.0 });
      if (a.rgb)        features.push({ type: 'color', hue: 0, saturationLevel: 0.0 });
      if (a.ct) {
        const { min, max } = rangeOf(a.ct, 2000, 9000);
        features.push({
          type: 'colorTemperature',
          colorTemperature:        Math.round((min + max) / 2),
          minimalColorTemperature: min,
          maximumColorTemperature: max,
        });
      }
      channels.push({ channel: 'main', deviceType: 'LIGHT', features });
    } else {
      channels.push({ channel: 'main', deviceType: 'SWITCH', features: [{ type: 'switchState', on: false }] });
    }
  } else if (!a.target && a.pm25) {
    const features = [pmFeature()];
    pmFree = false;
    takeClimate(features);
    channels.push({ channel: 'main', deviceType: 'PARTICULATE_MATTER_SENSOR', features });
  } else if (!a.target && (a.temp || a.hum)) {
    const features = [];
    takeClimate(features);
    channels.push({ channel: 'main', deviceType: 'CLIMATE_SENSOR', features });
  }

  // --- Zieltemperatur ---
  if (a.target) {
    const features = [{ type: 'setPointTemperature', setPointTemperature: 20.0 }];
    takeClimate(features);
    channels.push({ channel: 'thermostat', deviceType: 'THERMOSTAT', features });
  }

  // --- Feinstaub eines schaltbaren Geräts (z. B. Luftreiniger) ---
  if (pmFree) {
    const features = [pmFeature()];
    takeClimate(features);
    channels.push({ channel: 'pm', deviceType: 'PARTICULATE_MATTER_SENSOR', features });
  }

  // --- Übrige Temperatur/Feuchte eines schaltbaren Geräts ---
  if (tempFree || humFree) {
    const features = [];
    takeClimate(features);
    channels.push({ channel: 'climate', deviceType: 'CLIMATE_SENSOR', features });
  }

  // --- Einzelne Steckdosen einer Mehrfachsteckdose ---
  for (const s of a.sockets) {
    channels.push({ channel: `socket${s.index}`, deviceType: 'SWITCH', features: [{ type: 'switchState', on: false }] });
  }

  // Maintenance (Erreichbarkeit) ist bei allen Typen optional erlaubt
  for (const ch of channels) {
    ch.features.push({ type: 'maintenance', unreach: false });
    ch.features = filterAllowed(ch.deviceType, ch.features);
  }
  return channels;
}

/** Entfernt Features, die für den HmIP-Gerätetyp nicht erlaubt sind (Sicherheitsnetz). */
function filterAllowed(deviceType, features) {
  const spec = DEVICE_TYPE_FEATURES[deviceType];
  if (!spec) return features;
  const allowed = new Set([...spec.required, ...spec.optional]);
  return features.filter(f => allowed.has(f.type));
}

// ---------------------------------------------------------------------------
//  Govee-State → HmIP-Features
// ---------------------------------------------------------------------------

function stateValue(stateCaps, type, instance) {
  const c = findCap(stateCaps, type, instance);
  return c?.state?.value;
}

function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }
function celsiusToFahrenheit(c) { return c * 9 / 5 + 32; }
function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

/** Liest einen Zieltemperatur-State (Zahl oder Struct) und liefert °C. */
function parseTargetTemperature(value) {
  if (value === undefined || value === null || value === '') return null;
  let temp = value;
  let unit = null;
  if (typeof value === 'object') {
    temp = value.temperature ?? value.targetTemperature ?? value.value;
    unit = value.unit ?? null;
  }
  temp = Number(temp);
  if (!Number.isFinite(temp)) return null;
  if (typeof unit === 'string' && /^f/i.test(unit)) temp = fahrenheitToCelsius(temp);
  return round1(temp);
}

/**
 * Wandelt die State-Capabilities eines Govee-Geräts in die Features eines Kanals um.
 *
 * @param {object} channelDef – { channel, deviceType }
 * @param {Array}  stateCaps  – Capabilities aus /device/state
 * @param {object} goveeDevice – Govee-Gerät (für Ranges)
 * @param {object} opts
 * @param {string} opts.sensorUnit – 'F' | 'C': Einheit von sensorTemperature
 * @returns {object[]} Feature-Array (nur Features mit bekanntem Wert)
 */
function stateToFeatures(channelDef, stateCaps, goveeDevice, { sensorUnit = 'C' } = {}) {
  const a        = analyze(goveeDevice);
  const features = [];

  const online = stateValue(stateCaps, CAP.ONLINE, 'online');
  const pushClimate = () => {
    const t = stateValue(stateCaps, CAP.PROPERTY, 'sensorTemperature');
    if (Number.isFinite(Number(t)) && t !== null && t !== '') {
      const c = sensorUnit === 'F' ? fahrenheitToCelsius(Number(t)) : Number(t);
      features.push({ type: 'actualTemperature', actualTemperature: clamp(round1(c), -50, 60) });
    }
    const h = stateValue(stateCaps, CAP.PROPERTY, 'sensorHumidity');
    if (Number.isFinite(Number(h)) && h !== null && h !== '') {
      features.push({ type: 'humidity', humidity: clamp(Math.round(Number(h)), 0, 100) });
    }
  };

  switch (channelDef.channel) {
    case 'main': {
      const power = stateValue(stateCaps, CAP.ON_OFF, 'powerSwitch');
      if (power !== undefined) features.push({ type: 'switchState', on: Number(power) === 1 || power === true });

      if (channelDef.deviceType === 'LIGHT') {
        const bri = stateValue(stateCaps, CAP.RANGE, 'brightness');
        if (bri !== undefined && a.brightness) {
          const { max } = rangeOf(a.brightness, 1, 100);
          features.push({ type: 'dimming', dimLevel: clamp(Number(bri) / max, 0, 1) });
        }
        const ct  = Number(stateValue(stateCaps, CAP.COLOR, 'colorTemperatureK'));
        const rgb = stateValue(stateCaps, CAP.COLOR, 'colorRgb');
        // Govee meldet colorTemperatureK = 0, wenn das Gerät im RGB-Modus ist
        if (a.ct && Number.isFinite(ct) && ct > 0) {
          const { min, max } = rangeOf(a.ct, 2000, 9000);
          features.push(...colorModeFeatures('ct', { colorTemperature: clamp(Math.round(ct), min, max), min, max }, a));
        } else if (a.rgb && rgb !== undefined && rgb !== null) {
          const { h, s } = rgbIntToHsv(Number(rgb));
          features.push(...colorModeFeatures('rgb', { hue: h, saturationLevel: s }, a));
        }
      }

      if (channelDef.deviceType === 'CLIMATE_SENSOR') pushClimate();
      if (channelDef.deviceType === 'PARTICULATE_MATTER_SENSOR') {
        pushPm(features, stateCaps);
        pushClimate();
      }
      break;
    }

    case 'thermostat': {
      const target = parseTargetTemperature(stateValue(stateCaps, CAP.TEMP_SETTING, a.target?.instance ?? 'targetTemperature'));
      if (target !== null) features.push({ type: 'setPointTemperature', setPointTemperature: clamp(target, -50, 60) });
      pushClimate();
      break;
    }

    case 'pm':
      pushPm(features, stateCaps);
      pushClimate();
      break;

    case 'climate':
      pushClimate();
      break;

    default: {
      const m = channelDef.channel.match(/^socket(\d+)$/);
      if (m) {
        const v = stateValue(stateCaps, CAP.TOGGLE, `socketToggle${m[1]}`);
        if (v !== undefined) features.push({ type: 'switchState', on: Number(v) === 1 || v === true });
      }
    }
  }

  if (online !== undefined) features.push({ type: 'maintenance', unreach: !(online === true || online === 'true') });

  // Nur Features zurückgeben, die der Kanal auch besitzt (z. B. keine Feuchte
  // im Thermostat, wenn sie dem Klima-Kanal zugeordnet ist)
  const allowedTypes = new Set((channelDef.features ?? []).map(f => f.type));
  return allowedTypes.size ? features.filter(f => allowedTypes.has(f.type)) : features;
}

/**
 * Features für den aktiven Farbmodus einer Lampe. Der jeweils inaktive Modus
 * wird intern mit dem "Ignorieren"-Wert der Connect API markiert und beim
 * Senden an die HCU weggelassen (devices.statusFeatures). Erhält die HCU
 * Farbe und Farbtemperatur gleichzeitig, zeigt die Homematic IP App teils
 * den falschen Modus an.
 *
 * @param {'rgb'|'ct'} mode
 * @param {object} values – rgb: { hue, saturationLevel } | ct: { colorTemperature, min, max }
 * @param {object} a      – Ergebnis von analyze()
 */
function colorModeFeatures(mode, values, a) {
  const out = [];
  const ctRange = rangeOf(a.ct, 2000, 9000);
  if (mode === 'rgb') {
    if (a.rgb) out.push({ type: 'color', hue: values.hue, saturationLevel: values.saturationLevel });
    if (a.ct)  out.push({ type: 'colorTemperature', colorTemperature: CT_IGNORE, minimalColorTemperature: ctRange.min, maximumColorTemperature: ctRange.max });
  } else {
    if (a.ct)  out.push({ type: 'colorTemperature', colorTemperature: values.colorTemperature, minimalColorTemperature: values.min ?? ctRange.min, maximumColorTemperature: values.max ?? ctRange.max });
    if (a.rgb) out.push({ type: 'color', hue: HUE_IGNORE, saturationLevel: SAT_IGNORE });
  }
  return out;
}

/**
 * Ergänzt die Features eines erfolgreichen CONTROL_REQUEST um den
 * "Ignorieren"-Wert des jeweils anderen Farbmodus (siehe colorModeFeatures).
 * Spezialwerte aus dem Request selbst werden nicht übernommen.
 */
function appliedFeatures(channelDef, features, current, goveeDevice) {
  const known  = new Set((current ?? []).map(f => f.type));
  const real   = features.filter(f => known.has(f.type) && !isSpecialFeature(f));
  if (channelDef.deviceType !== 'LIGHT') return real;

  const a    = analyze(goveeDevice);
  const rest = real.filter(f => f.type !== 'color' && f.type !== 'colorTemperature');

  // Ein-/Ausschalten per dimLevel (siehe featuresToCommands) auch als switchState melden
  const dim = rest.find(f => f.type === 'dimming');
  if (dim && !rest.some(f => f.type === 'switchState') && known.has('switchState')) {
    rest.unshift({ type: 'switchState', on: Number(dim.dimLevel) > 0 });
  }

  const ct = real.find(f => f.type === 'colorTemperature');
  if (ct) {
    const prev = (current ?? []).find(f => f.type === 'colorTemperature') ?? {};
    return [...rest, ...colorModeFeatures('ct', { colorTemperature: ct.colorTemperature, min: prev.minimalColorTemperature, max: prev.maximumColorTemperature }, a)];
  }

  // Farbe: Farbton und Sättigung können einzeln als "ignorieren" kommen,
  // der fehlende Teil wird aus dem gespeicherten Wert ergänzt
  const color = features.find(f => f.type === 'color');
  if (color && known.has('color')) {
    const hueIn = Number(color.hue);
    const satIn = Number(color.saturationLevel);
    const hueOk = Number.isFinite(hueIn) && hueIn < HUE_IGNORE;
    const satOk = Number.isFinite(satIn) && satIn < LEVEL_SPECIAL_MIN;
    if (hueOk || satOk) {
      const prev = (current ?? []).find(f => f.type === 'color') ?? {};
      const hue  = hueOk ? hueIn % 360 : (prev.hue < HUE_IGNORE ? prev.hue : 0);
      const sat  = satOk ? satIn : (prev.saturationLevel < LEVEL_SPECIAL_MIN ? prev.saturationLevel : 1);
      return [...rest, ...colorModeFeatures('rgb', { hue, saturationLevel: sat }, a)];
    }
  }
  return rest;
}

/** true, wenn ein Feature einen Spezialwert der Connect API ("ignorieren"/"letzter Wert") trägt. */
function isSpecialFeature(f) {
  switch (f.type) {
    case 'dimming':          return Number(f.dimLevel) >= LEVEL_SPECIAL_MIN;
    case 'color':            return Number(f.hue) >= HUE_IGNORE || Number(f.saturationLevel) >= LEVEL_SPECIAL_MIN;
    case 'colorTemperature': return Number(f.colorTemperature) >= CT_SPECIAL_MIN;
    default:                 return false;
  }
}

function pushPm(features, stateCaps) {
  const c = findCap(stateCaps, CAP.PROPERTY, PM25_REGEX);
  const v = Number(c?.state?.value);
  if (c && Number.isFinite(v)) {
    features.push({ type: 'particulateMassTwoPointFive', particulateMassConcentrationTwoPointFive: Math.max(0, v) });
  }
}

// ---------------------------------------------------------------------------
//  HmIP-CONTROL_REQUEST → Govee-Steuerbefehle
// ---------------------------------------------------------------------------

/**
 * Übersetzt die Features eines CONTROL_REQUEST in Govee-Capabilities.
 *
 * @param {object} channelDef   – { channel, deviceType }
 * @param {Array}  features     – Features aus dem CONTROL_REQUEST
 * @param {Array}  current      – aktuell bekannte Features des HCU-Geräts
 * @param {object} goveeDevice  – Govee-Gerät (für Ranges/Struct-Felder)
 * @returns {Array<{type, instance, value}>} Befehle in Ausführungsreihenfolge
 */
function featuresToCommands(channelDef, features, current, goveeDevice) {
  const a    = analyze(goveeDevice);
  const cmds = [];
  const get  = (type) => features.find(f => f.type === type);
  const cur  = (type) => (current ?? []).find(f => f.type === type) ?? {};

  const sw = get('switchState');

  // --- Steckdosen-Kanal ---
  const sock = channelDef.channel.match(/^socket(\d+)$/);
  if (sock) {
    if (sw && sw.on !== undefined) cmds.push({ type: CAP.TOGGLE, instance: `socketToggle${sock[1]}`, value: toBool(sw.on) ? 1 : 0 });
    return cmds;
  }

  // --- Thermostat-Kanal ---
  if (channelDef.channel === 'thermostat') {
    const sp = get('setPointTemperature');
    if (sp && Number.isFinite(Number(sp.setPointTemperature)) && a.target) {
      cmds.push({ type: CAP.TEMP_SETTING, instance: a.target.instance, value: buildTemperatureValue(a.target, Number(sp.setPointTemperature)) });
    }
    return cmds;
  }

  if (channelDef.channel !== 'main' || !a.power) return cmds;

  // --- Hauptkanal (LIGHT / SWITCH) ---
  let turnOn  = sw ? toBool(sw.on) : null;
  const dim   = get('dimming');
  const color = get('color');
  const ctF   = get('colorTemperature');

  const dimLevel = dim && Number(dim.dimLevel);
  const dimValid = dim && Number.isFinite(dimLevel) && dimLevel < LEVEL_SPECIAL_MIN;

  // dimLevel 0 = ausschalten (so bildet die HCU den Aus-Zustand eines Dimmers ab)
  if (dimValid && dimLevel <= 0 && turnOn === null) turnOn = false;
  // Die HCU schaltet Dimmer über dimLevel > 0 ein, ohne switchState zu senden.
  // Nicht jedes Gerät schaltet sich bei einem Helligkeitsbefehl selbst ein.
  if (dimValid && dimLevel > 0 && turnOn === null && cur('switchState').on === false) turnOn = true;

  if (turnOn === false) {
    cmds.push({ type: CAP.ON_OFF, instance: 'powerSwitch', value: 0 });
    return cmds; // beim Ausschalten keine weiteren Befehle (würden das Gerät wieder einschalten)
  }
  if (turnOn === true) cmds.push({ type: CAP.ON_OFF, instance: 'powerSwitch', value: 1 });

  if (channelDef.deviceType !== 'LIGHT') return cmds;

  if (dimValid && dimLevel > 0 && a.brightness) {
    const { min, max } = rangeOf(a.brightness, 1, 100);
    cmds.push({ type: CAP.RANGE, instance: 'brightness', value: clamp(Math.round(dimLevel * max), min, max) });
  }

  if (color && a.rgb) {
    let hue = Number(color.hue);
    let sat = Number(color.saturationLevel);
    const hueValid = Number.isFinite(hue) && hue < HUE_IGNORE;
    const satValid = Number.isFinite(sat) && sat < LEVEL_SPECIAL_MIN;
    if (hueValid || satValid) {
      const prevHue = Number(cur('color').hue);
      const prevSat = Number(cur('color').saturationLevel);
      if (!hueValid) hue = prevHue < HUE_IGNORE ? prevHue : 0;
      if (!satValid) sat = prevSat < LEVEL_SPECIAL_MIN ? prevSat : 1;
      cmds.push({ type: CAP.COLOR, instance: 'colorRgb', value: hsvToRgbInt(hue % 360, clamp(sat, 0, 1), 1) });
    }
  }

  if (ctF && a.ct) {
    const k = Number(ctF.colorTemperature);
    if (Number.isFinite(k) && k > 0 && k < CT_SPECIAL_MIN) {
      const { min, max } = rangeOf(a.ct, 2000, 9000);
      cmds.push({ type: CAP.COLOR, instance: 'colorTemperatureK', value: clamp(Math.round(k), min, max) });
    }
  }

  return cmds;
}

/** Baut den Struct-Wert für temperature_setting anhand der Felddefinitionen. */
function buildTemperatureValue(cap, celsius) {
  const fields    = cap.parameters?.fields ?? [];
  const unitField = fields.find(f => f.fieldName === 'unit');
  const unitOpts  = (unitField?.options ?? []).map(o => String(o.value ?? o.name));
  const useF      = unitOpts.length > 0 && !unitOpts.some(u => /^c/i.test(u));
  const unit      = useF ? (unitOpts.find(u => /^f/i.test(u)) ?? 'Fahrenheit') : (unitOpts.find(u => /^c/i.test(u)) ?? 'Celsius');

  let temp = useF ? celsiusToFahrenheit(celsius) : celsius;
  const tField = fields.find(f => f.fieldName === 'temperature');
  if (tField?.range) temp = clamp(temp, tField.range.min, tField.range.max);
  const precision = tField?.range?.precision ?? 1;
  temp = Math.round(temp / precision) * precision;

  const value = { temperature: temp, unit };
  for (const f of fields) {
    if (f.fieldName === 'temperature' || f.fieldName === 'unit') continue;
    if (f.required) value[f.fieldName] = f.defaultValue ?? f.options?.[0]?.value ?? f.range?.min ?? 0;
  }
  if (fields.length === 0) return { temperature: Math.round(celsius), unit: 'Celsius' };
  return value;
}

function toBool(v) { return v === true || v === 'true' || v === 1; }

// ---------------------------------------------------------------------------
//  Farbumrechnung
// ---------------------------------------------------------------------------

function rgbIntToHsv(int) {
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d   = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: Math.round(h) % 360, s: Math.round(s * 100) / 100, v: max };
}

function hsvToRgbInt(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  const to = (n) => Math.round((n + m) * 255);
  return (to(r) << 16) + (to(g) << 8) + to(b);
}

// ---------------------------------------------------------------------------
//  Govee LAN-API (nur Lampen): Umsetzung auf/von Cloud-Capabilities
// ---------------------------------------------------------------------------

/** true, wenn das Gerät lokal steuerbar sein kann (Hauptkanal ist eine Lampe). */
function isLanCapable(goveeDevice) {
  const a = analyze(goveeDevice);
  return Boolean(a.power && a.isLight);
}

/**
 * LAN-devStatus > State-Capabilities im Format der Cloud-API, damit
 * stateToFeatures() unverändert genutzt werden kann.
 * @param {object} data – { onOff, brightness, color:{r,g,b}, colorTemInKelvin }
 */
function lanStatusToStateCaps(data, goveeDevice) {
  const a    = analyze(goveeDevice);
  const caps = [{ type: CAP.ONLINE, instance: 'online', state: { value: true } }];
  if (data.onOff !== undefined) caps.push({ type: CAP.ON_OFF, instance: 'powerSwitch', state: { value: Number(data.onOff) ? 1 : 0 } });
  if (data.brightness !== undefined) {
    // LAN liefert 1–100; auf den Bereich der Cloud-Capability umrechnen
    const { max } = rangeOf(a.brightness, 1, 100);
    caps.push({ type: CAP.RANGE, instance: 'brightness', state: { value: Math.round(Number(data.brightness) * max / 100) } });
  }
  if (data.color) {
    const { r = 0, g = 0, b = 0 } = data.color;
    caps.push({ type: CAP.COLOR, instance: 'colorRgb', state: { value: ((r & 0xff) << 16) + ((g & 0xff) << 8) + (b & 0xff) } });
  }
  if (data.colorTemInKelvin !== undefined) {
    caps.push({ type: CAP.COLOR, instance: 'colorTemperatureK', state: { value: Number(data.colorTemInKelvin) || 0 } });
  }
  return caps;
}

/**
 * Cloud-Steuerbefehle (aus featuresToCommands) > LAN-Befehle.
 * @returns {Array<{cmd:string, data:object}>|null} null, wenn ein Befehl lokal nicht abbildbar ist
 */
function commandsToLan(cmds, goveeDevice) {
  const a   = analyze(goveeDevice);
  const out = [];
  for (const c of cmds) {
    if (c.instance === 'powerSwitch') {
      out.push({ cmd: 'turn', data: { value: c.value ? 1 : 0 } });
    } else if (c.instance === 'brightness') {
      const { max } = rangeOf(a.brightness, 1, 100);
      out.push({ cmd: 'brightness', data: { value: clamp(Math.round(c.value * 100 / max), 1, 100) } });
    } else if (c.instance === 'colorRgb') {
      out.push({ cmd: 'colorwc', data: { color: { r: (c.value >> 16) & 0xff, g: (c.value >> 8) & 0xff, b: c.value & 0xff }, colorTemInKelvin: 0 } });
    } else if (c.instance === 'colorTemperatureK') {
      out.push({ cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: c.value } });
    } else {
      return null;
    }
  }
  return out;
}

module.exports = {
  buildChannels,
  stateToFeatures,
  featuresToCommands,
  appliedFeatures,
  isLanCapable,
  lanStatusToStateCaps,
  commandsToLan,
  rgbIntToHsv,
  hsvToRgbInt,
  CAP,
};
