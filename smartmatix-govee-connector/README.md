# SmartMatix Govee Connector

![Das Plugin-Icon von SmartMatix Govee Connector](/Screenshots/govee-connector-plugin-header.png "Plugin-Icon")

Ein Plugin für die **Homematic IP Home Control Unit (HCU)**, das Govee-Geräte über die [Govee OpenAPI](https://developer.govee.com/) in das Homematic IP System einbindet – über die [Connect API 1.0.1](https://github.com/homematicip/connect-api).

> Entwickelt von **Kevin Schipper** · Plugin-ID: `de.smartmatix.plugin.govee-connector`

---

## Einsatzmöglichkeiten

Mit dem **SmartMatix Govee Connector** steuerst du deine Govee-Lampen, -Steckdosen und -Haushaltsgeräte direkt über deine **Homematic IP** Zentrale und nutzt die Messwerte deiner Govee-Thermometer in Homematic-IP-Automatisierungen.

![So konfigurierst du das Plugin in der HCU Web](/Screenshots/Konfiguration-des-Govee-Connector-Plugins-in-der-Homematic-IP-HCU.jpg "Einstellungen des Plugins in der HCU-Weboberfläche")

---

## Features

- **Anmeldung per Govee-API-Key** – danach erscheinen alle Geräte deines Govee-Kontos als eigene Tabs in den Plugin-Einstellungen
- **Auswahl per Haken** – nur Geräte mit gesetztem Haken "Zu Homematic IP hinzufügen" werden eingebunden
- **Neue Geräte automatisch hinzufügen** – neue Geräte im Govee-Konto werden vom Plugin automatisch hinzugefügt
- **Reinkludieren** – in der App gelöschte Geräte werden beim nächsten Speichern oder Plugin-Start erneut hinzugefügt, solange der Haken gesetzt ist
- **Lokale Steuerung per Govee LAN-API** – Lampen mit aktiviertem "LAN Control" (muss vom Gerät unterstützt werden) werden direkt im Heimnetz gesteuert und alle 5 s abgefragt, ohne Cloud-Limit; automatischer Rückfall auf die Cloud bei Ausfall
- **Polling-basierter Statusabgleich** – Intervall 1 min bis 1 h (automatisch auf das Govee-API-Tageskontingent begrenzt)
- **Automatische Wiederverbindung** – Exponential Backoff bei Verbindungsabbruch zur HCU
- **Backup & Restore** – alle Plugin-Daten lassen sich als JSON-Datei exportieren und wiederherstellen

![Konfiguration einer Govee Leuchte im Smartmatix Govee Connector Plugin](/Screenshots/Konfiguration-einer-Govee-Leuchte-in-der-Homematic-IP-HCU.jpg "Konfiguration einer Govee Leuchte im Smartmatix Govee Connector Plugin")

![Verbundene Govee Leuchte in der Homematic IP App](/Screenshots/Steuerung-einer-Govee-Leuchte-in-der-Homematic-IP-App.jpg "Verbundene Govee Leuchte in der Homematic IP App")

---

## Gerätezuordnung

Jedes Govee-Gerät wird auf so wenige Homematic-IP-Geräte wie möglich abgebildet. Funktionen ohne Gegenstück in Homematic IP Connect API (Szenen, Modi, Lüfterstufen, Segmentfarben, Musikmodus, Zielfeuchte …) werden weggelassen.

| Govee | Homematic IP | Funktionen |
|---|---|---|
| Lampen, Lichtleisten, TV-Backlight-Boxen | `LIGHT` | Ein/Aus, Helligkeit, Farbe, Farbtemperatur |
| Steckdosen, Haushaltsgeräte mit Ein/Aus | `SWITCH` | Ein/Aus |
| Mehrfachsteckdosen (`socketToggleN`) | je Dose ein `SWITCH` | Ein/Aus je Dose |
| Geräte mit Zieltemperatur (z. B. Heizlüfter) | zusätzlich `THERMOSTAT` | Solltemperatur, Ist-Temperatur/Feuchte |
| Geräte mit PM2.5-Messung (z. B. Luftreiniger) | zusätzlich `PARTICULATE_MATTER_SENSOR` | PM2.5 (+ Temperatur/Feuchte) |
| Thermo-/Hygrometer | `CLIMATE_SENSOR` | Temperatur, Luftfeuchte |
| sonstige Messwerte schaltbarer Geräte | zusätzlich `CLIMATE_SENSOR` | Temperatur, Luftfeuchte |

Alle Geräte melden zusätzlich die Erreichbarkeit (`maintenance.unreach`). Präsenzsensoren (nur per MQTT-Event) werden in dieser Version noch nicht unterstützt.

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.6.16 |
| Govee-API-Key | [beantragen](https://developer.govee.com/reference/apply-you-govee-api-key) (Govee Home App → Profil → Einstellungen → API-Key beantragen) |
| Internetzugang der HCU | erforderlich (Govee OpenAPI ist eine Cloud-API) |
| Entwicklermodus | aktiviert (HCUweb) |

---

## Projektstruktur

```
smartmatix-govee-connector/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── THIRD_PARTY_LICENSES.md
├── constants/
│   ├── device_constants.js           ← Gerätetypen & Default-Features
│   └── feature_catalog.js            ← Feature-Katalog der Connect API 1.0.1
├── data/
│   ├── config.json                   ← API-Key, Auto-Add, Intervall, Einheit
│   ├── devices.json                  ← HCU-Geräte (Kanäle) mit Govee-Verknüpfung
│   └── govee.json                    ← Govee-Gerätecache inkl. Haken je Gerät
├── lang/
│   └── localization.json             ← Plugin-Übersetzungen (de/en)
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Einstellungsmenü, Polling
    ├── govee.js                      ← Govee OpenAPI Client
    ├── goveeMapping.js               ← Govee-Capabilities ⇄ HmIP-Geräte/Features
    ├── goveeLan.js                   ← Govee LAN-API Client (UDP, lokale Lampensteuerung)
    ├── devices.js                    ← Verwaltung der HCU-Geräte
    ├── devicesStore.js               ← Persistenz für Geräte & Govee-Daten
    ├── configStore.js                ← Persistenz für Konfiguration
    ├── backup-plugin-data.js         ← Bibliothek: Backup & Restore (nicht verändern)
    ├── localization.js               ← Übersetzungen ausgeben
    ├── logger.js                     ← Konsolenlogger
    └── notifications.js              ← HCU-Benachrichtigungen
```

---

## Ersteinrichtung in der HCUweb

1. Plugin-Einstellungen öffnen (`Plugins → SmartMatix Govee Connector → Einstellungen`)
2. Im Tab **Allgemein** den Govee-API-Key eintragen
3. Optional: **"Neue Geräte automatisch hinzufügen"** setzen – dann werden sofort alle Geräte eingebunden
4. Speichern – danach erscheint für jedes Govee-Gerät ein eigener Tab
5. In den Geräte-Tabs den Haken **"Zu Homematic IP hinzufügen"** setzen und speichern
6. Die Geräte im Posteingang der Homematic IP App bestätigen

---

## Einstellungen in der HCUweb

### Allgemein

| Einstellung | Beschreibung | Standard |
|---|---|---|
| **Govee-API-Key** | Persönlicher Key deines Govee-Kontos | – |
| **Verbindungsstatus** | Verbunden / Key ungültig / Cloud nicht erreichbar | – |
| **Neue Geräte automatisch hinzufügen** | Vor dem ersten Verbinden: alle Geräte; nachträglich: nur neue Geräte | Nein |
| **Status-Abfrageintervall** | 1 min bis 1 h; wird bei vielen Geräten automatisch verlängert | 5 min |
| **Temperatureinheit der Govee-Sensoren** | Einheit, in der Govee `sensorTemperature` liefert | Celsius |
| **Lampen lokal steuern (Govee LAN-API)** | Lampen mit "LAN Control" direkt im Heimnetz steuern, Rückfall auf die Cloud | Ja |
| **Lokal erreichbare Lampen** | Anzeige der aktuell lokal gesteuerten Lampen mit IP | – |

### Je gefundenem Gerät

| Einstellung | Beschreibung |
|---|---|
| **Zu Homematic IP hinzufügen** | Gerät einbinden. Haken entfernen = Gerät wird nicht mehr bedient, Hinweis in der App zum Löschen |
| **Wird eingebunden als** | Homematic-IP-Gerätetyp(en) für dieses Govee-Gerät |

---

## Geräte löschen und reinkludieren

- **In der Homematic IP App gelöscht:** Das Plugin bedient das Gerät nicht mehr (`EXCLUSION_EVENT`). Ist der Haken weiterhin gesetzt, wird es beim **nächsten Speichern** der Plugin-Einstellungen **oder beim nächsten Plugin-Start** mit derselben Geräte-ID wieder hinzugefügt. Dazu meldet das Plugin in diesen Momenten alle angehakten Geräte erneut an die HCU – so kommen auch Geräte zurück, die gelöscht wurden, während das Plugin nicht lief.
- **Haken entfernt:** Die Connect API erlaubt dem Plugin nicht, Geräte in der HCU zu löschen. Das Plugin bedient das Gerät deshalb nicht mehr und zeigt in der App einen Hinweis, es dort zu löschen.

---

## Lokale Steuerung (Govee LAN-API)

Lampen, bei denen in der Govee Home App unter *Geräteeinstellungen → LAN Control* die lokale Steuerung aktiviert ist, steuert das Plugin direkt im Heimnetz (UDP):

| Richtung | Port | Zweck |
|---|---|---|
| Plugin → Lampe | 4001 | `scan` (Unicast an alle Adressen im /24-Subnetz der HCU) |
| Lampe → Plugin | 4002 | Antworten (`EXPOSE 4002` / `4002/udp` im Dockerfile) |
| Plugin → Lampe | 4003 | `turn`, `brightness`, `colorwc`, `devStatus` |

- Die LAN-IP der HCU kommt per `SYSTEM_INFO_REQUEST`; Multicast/mDNS wird nicht benötigt.
- Die Zuordnung zur Cloud-Geräteliste erfolgt über die Geräte-ID (MAC) aus der Scan-Antwort.
- Die HCU reicht Port 4002 über einen Proxy durch, dabei geht die Absender-IP verloren. `devStatus`-Antworten enthalten keine Geräte-ID, deshalb wird immer nur **eine Lampe gleichzeitig** abgefragt.
- Status alle 5 s, Scan beim Start, nach dem Speichern und alle 5 min.
- Antwortet eine Lampe dreimal nicht, läuft sie automatisch wieder über die Cloud, bis ein Scan sie erneut findet.
- Nicht-Lampen (Steckdosen, Sensoren, Haushaltsgeräte) unterstützen die LAN-API nicht und laufen immer über die Cloud.

---

## Govee-Limits

Govee begrenzt die Anfragen pro Account (u. a. ein Tageskontingent von 10.000 Anfragen). Lokal erreichbare Lampen zählen dabei nicht mit. Für alle anderen Geräte nutzt das Plugin für das Polling höchstens 70 % davon und verlängert das Intervall bei Bedarf automatisch (Beispiel: 20 Geräte → mindestens alle 247 s). Nach einem Steuerbefehl pausiert das Polling des Geräts 15 s, damit verzögerte Cloud-Zustände den neuen Wert nicht überschreiben.

---

## Backup & Restore

**Backup erstellen:**
1. Unter "Backup & Wiederherstellung" die Aktion **Backup starten** wählen und speichern
2. Einstellungen erneut öffnen → Button zum Herunterladen erscheint
3. Die Backup-Datei einmalig herunterladen – danach verfällt der Link automatisch

**Backup wiederherstellen:**
1. Aktion **Wiederherstellung starten** wählen und speichern
2. Einstellungen erneut öffnen → Sicherheits-Token und Link zur Restore-Seite erscheinen
3. Restore-Seite öffnen, Token eingeben und Backup-Datei hochladen
4. Das Plugin startet nach erfolgreicher Wiederherstellung automatisch neu

> **Hinweis:** Der temporäre Backup-/Restore-Server lauscht auf Port **8746** (`BACKUP_PORT` in `plugin.js`, passend zu `EXPOSE` im Dockerfile), damit er nicht mit anderen SmartMatix-Plugins (8743) kollidiert.

> **Hinweis:** Ein Backup einer neueren Hauptversion kann nicht in eine ältere Hauptversion eingespielt werden.

---

## Lokale Entwicklung

```bash
git clone https://github.com/Spider-S001/smartmatix-govee-connector.git
cd smartmatix-govee-connector
npm install
echo "DEIN-AUTHTOKEN" > authtoken.txt
node src/index.js de.smartmatix.plugin.govee-connector hcu1-XXXX.local authtoken.txt
```

Mit Debug-Logging:

```bash
LOG_LEVEL=debug node src/index.js de.smartmatix.plugin.govee-connector hcu1-XXXX.local authtoken.txt
```

---

## Deployment auf der HCU

```bash
docker buildx build --platform linux/arm64 -t smartmatix-govee-connector:1.0.0 .
docker save smartmatix-govee-connector:1.0.0 | gzip > smartmatix-govee-connector-1.0.0.tar.gz
```

HCUweb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

---

## Protokollablauf

```
Plugin                                    HCU
  │── PLUGIN_STATE_RESPONSE ─────────────►│  READY (bzw. CONFIG_REQUIRED ohne API-Key)
  │◄── CONFIG_UPDATE_REQUEST ─────────────│  API-Key / Haken gespeichert
  │── [Govee: GET /user/devices] ─────────│
  │── CONFIG_UPDATE_RESPONSE ────────────►│
  │── PLUGIN_STATE_RESPONSE READY ───────►│  triggert Discover
  │◄── DISCOVER_REQUEST ──────────────────│
  │── DISCOVER_RESPONSE ─────────────────►│  angehakte, noch nicht gemeldete Geräte
  │◄── INCLUSION_EVENT ───────────────────│
  │── STATUS_RESPONSE / STATUS_EVENT ────►│
  │◄── CONTROL_REQUEST ───────────────────│
  │── [Govee: POST /device/control] ──────│
  │── CONTROL_RESPONSE + STATUS_EVENT ───►│
  │◄── EXCLUSION_EVENT ───────────────────│  Gerät in der App gelöscht
  │   [Intervall] Govee: POST /device/state
  │── STATUS_EVENT (bei Änderung) ───────►│
```

---

## Datenhaltung

| Datei | Inhalt |
|---|---|
| `config.json` | API-Key, Auto-Add, Polling-Intervall, Temperatureinheit |
| `devices.json` | HCU-Geräte mit Govee-Verknüpfung und Aufnahme-Status |
| `govee.json` | Govee-Gerätecache (Capabilities) und Haken je Gerät |

> **Sicherheitshinweis:** Der Govee-API-Key wird im Klartext in `config.json` gespeichert. Der Zugriff auf `/data` ist durch die Container-Isolierung der HCU geschützt.

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2026 Kevin Schipper
