# Zigbee Thermostat

This OpenClaw provider uses the maintained Zigbee2MQTT SONOFF TRV-ZBT profile.
OpenClaw Device Management owns the inventory and agent grants. A thermostat is
addressed by its provisioned IEEE identity on a local broker. The tools accept
inventory IDs and never accept MQTT topics, addresses or arbitrary payloads.

| Tool | Device grant | Functions |
| --- | --- | --- |
| `thermostat_status` | `read` | Temperature and mode, settings, diagnostics, one of three weekly profiles, temperature history |
| `thermostat_control` | `control` | Target temperature, mode, weekly profile selection and updates, boost/timer, adaptive PID |
| `thermostat_calibrate` | `control` | Valve travel calibration with `confirm: true` |

Use `set_mode` with `heat` to suspend the weekly schedule, `auto` to resume it,
or `off` for the device's frost protection mode. `set_schedule` takes a `group`
and the days to change. A day takes an ordered list of `{ time, temperatureC }`
entries beginning at 00:00. Read the desired group explicitly with
`thermostat_status`. For history pass the `historyType` and an ISO time range
with explicit time zones. Missing status fields are listed separately.

## Local broker and device binding

Use an authenticated MQTT listener on loopback. Allow the OpenClaw account
to subscribe to the exact device topic and publish to that device's `/get`
and `/set` topics only. Configure the broker credentials in the OpenClaw
service environment as `OPENCLAW_ZIGBEE_MQTT_USERNAME` and
`OPENCLAW_ZIGBEE_MQTT_PASSWORD`. Give Zigbee2MQTT a separate broker account.

Keep the device's Zigbee2MQTT friendly name equal to its IEEE address. Set
`optimistic: false` and `retain: false` on the Zigbee2MQTT device and set
`advanced.cache_state: false` on the bridge. This lets the extension wait for
fresh device reports, including after an explicit read following a write.
Keep the bridge dedicated to this configuration when another integration
requires Zigbee2MQTT's merged state cache. An interrupted write reports
`device_write_unconfirmed` so the caller can check current state before
retrying. The bridge must already own the coordinator and Zigbee network.
Use the original network parameters when importing an existing coordinator.

Set the provider config at `plugins.entries.thermostat.config`, for example:

```json
{
  "baseTopic": "zigbee2mqtt",
  "port": 1883,
  "devices": [{ "id": "room_heater", "ieeeAddress": "0x0011223344556677" }]
}
```

Register the provider package with Device Management and add its inventory
entry. Use `read` by itself for observation and add `control` for write access.

```json
{
  "id": "room_heater",
  "name": "Radiator",
  "kind": "thermostat",
  "siteId": "example_site",
  "room": "Study",
  "provider": "thermostat",
  "grants": { "example_owner": ["read", "control"] }
}
```

[SONOFF device profile](https://www.zigbee2mqtt.io/devices/TRV-ZBT.html) ·
[Zigbee2MQTT device settings](https://www.zigbee2mqtt.io/guide/configuration/devices-groups.html)
