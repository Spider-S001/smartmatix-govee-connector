# Basis-Image der HCU (ARM64 – Pflicht für Deployment auf der HCU)
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Abhängigkeiten: vorinstallierte node_modules direkt mitkopieren.
# npm install läuft auf dem Build-Rechner
COPY package*.json  ./
COPY node_modules/  ./node_modules/

# Quellcode kopieren
COPY src/        ./src/
COPY constants/  ./constants/
COPY lang/       ./lang/

# Einstiegspunkt:
#   Argument 1: Plugin-ID
#   Argument 2: HCU-Host (host.containers.internal = HCU selbst)
#   Argument 3: Pfad zur Auth-Token-Datei (von der HCU bereitgestellt unter /TOKEN)
EXPOSE 8746

# Govee LAN-API: Lampen antworten immer an Port 4002 der Absender-IP (UDP).
EXPOSE 4002
EXPOSE 4002/udp

ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.govee-connector", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion mindestens 1.6.16 für Connect API 1.0.1
#  scope         LOCAL
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.govee-connector",\
  "issuer": "Kevin Schipper",\
  "version": "1.0.0",\
  "hcuMinVersion": "1.6.16",\
  "scope": "LOCAL",\
  "settings": [],\
  "friendlyName": {\
    "en": "SmartMatix Govee Connector",\
    "de": "SmartMatix Govee Connector"\
  },\
  "description": {\
    "en": "A plugin for controlling your Govee devices via the HCU.",\
    "de": "Ein Plugin, um deine Govee-Geraete über die HCU zu steuern."\
  },\
  "image": "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",\
  "logsEnabled": true\
}'
