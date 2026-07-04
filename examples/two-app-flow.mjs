// Two-app E2E flow (a user app and an operator app), run with:
//
//   flutter-axi run < examples/two-app-flow.mjs
//
// Prerequisites:
//   - Two devices booted (e.g. two simulators, or a simulator + an emulator)
//   - Both projects prepared once: flutter-axi setup driver <root> && flutter pub get
//   - Adjust roots/devices below.

const USER_ROOT = process.env.USER_APP_ROOT ?? "~/apps/user-app";
const OPERATOR_ROOT = process.env.OPERATOR_APP_ROOT ?? "~/apps/operator-app";
const USER_DEVICE = process.env.USER_DEVICE ?? "<simulator-udid-1>";
const OPERATOR_DEVICE = process.env.OPERATOR_DEVICE ?? "<simulator-udid-2>";

const user = apps.user;
const operator = apps.operator;

// Launch both apps (first launch compiles - be patient).
await user.launch(USER_ROOT, { device: USER_DEVICE });
console.log("user app up");
await operator.launch(OPERATOR_ROOT, { device: OPERATOR_DEVICE });
console.log("operator app up");

// Location + permissions without OS dialogs.
await user.permission("grant", "location");
await operator.permission("grant", "location");
await user.gps(37.7749, -122.4194);
await operator.gps(37.776, -122.417);

// The user submits a request.
console.log(await user.snapshot());
await user.tap("text:Submit Request"); // adapt to the real button text/key

// The operator receives and accepts it.
await operator.waitFor("New request", { timeout: 30000 });
await operator.tap("text:Accept");

// The user sees the confirmation; the operator's location updates.
await user.waitFor("Request accepted", { timeout: 30000 });
await operator.gps(37.7755, -122.418);

console.log("two-app flow OK");
