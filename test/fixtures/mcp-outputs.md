# Captured Dart MCP server output formats (Dart SDK 3.11.5, 2026-07)

Live-captured against the counter fixture on an iOS simulator. These are the
formats the parsers in src/ are written against. All tools return JSON text.

## list_devices

```json
{"devices":[{"name":"iPhone SE (3rd generation)","id":"00920CD6-2DFD-4A6F-9339-709459BBEE60","isSupported":true,"targetPlatform":"ios","emulator":true,"sdk":"com.apple.CoreSimulator.SimRuntime.iOS-18-2","capabilities":{"hotReload":true,"hotRestart":true,"screenshot":true,"flutterExit":true,"hardwareRendering":false,"startPaused":true}},{"name":"macOS","id":"macos","isSupported":true,"targetPlatform":"darwin","emulator":false,"sdk":"macOS 15.6 24G84 darwin-arm64","capabilities":{}},{"name":"Chrome","id":"chrome","isSupported":true,"targetPlatform":"web-javascript","emulator":false,"sdk":"Google Chrome 149.0.7827.201","capabilities":{}}]}
```

## launch_app

```json
{"dtdUri":"ws://127.0.0.1:58210/P99OlZpu_mo=","pid":56109}
```

## list_running_apps

```json
{"apps":[{"pid":56109,"dtdUri":"ws://127.0.0.1:58210/P99OlZpu_mo="}]}
```

## stop_app

```json
{"success":true}
```

## get_widget_tree (summaryOnly: true)

See widget-tree-counter.json. Node shape:

```json
{
  "description": "Text",
  "shouldIndent": true,
  "widgetRuntimeType": "Text",
  "valueId": "inspector-12",
  "createdByLocalProject": true,
  "textPreview": "0",
  "children": []
}
```

## flutter_driver

```json
{"isError":false,"response":{"status":"ok"},"type":"_extensionType","method":"ext.flutter.driver"}   // get_health
{"isError":false,"response":{},"type":"_extensionType","method":"ext.flutter.driver"}                // tap
{"isError":false,"response":{"text":"1"},"type":"_extensionType","method":"ext.flutter.driver"}      // get_text
```

Errors come back as isError:true with a `response` string (stack trace), e.g.
the driver-extension-not-enabled error, or as an MCP tool error whose text is
the message.

`screenshot` returns an MCP **image content block** (base64 png), not text —
the bridge must forward image blocks.

## get_app_logs

```json
{"logs":["[stdout] [{\"event\":\"app.start\",\"params\":{...\"deviceId\":\"...\",\"mode\":\"debug\"}}]","[stdout] Launching lib/flutter_axi_main.dart on iPhone SE (3rd generation) in debug mode...", "..."]}
```

## Gotchas discovered live

1. **flutter_driver requires the driver extension**: apps must be launched
   with an entrypoint that calls `enableFlutterDriverExtension()` before
   `runApp` and have `flutter_driver` in dev_dependencies. Otherwise every
   driver command errors with "The flutter driver extension is not enabled."
   => flutter-axi `setup driver` + `launch` defaults `--target` to the shim.
2. **Descendant/Ancestor nested finders are broken in dart mcp-server
   3.11.5**: the server passes the nested `of`/`matching` maps to the driver
   via Dart `toString()` instead of JSON, and `Descendant.deserialize`'s
   jsonDecode fails with FormatException. Simple finders (ByText, ByValueKey,
   ByType, ByTooltipMessage, BySemanticsLabel, PageBack) work. => uid->finder
   derivation uses only simple finders; ambiguous nodes get no uid.
3. get_widget_tree requires connect_dart_tooling_daemon(dtdUri) first; the
   DTD URI comes from launch_app's response.
