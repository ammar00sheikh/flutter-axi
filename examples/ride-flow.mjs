// Two-app rider-driver E2E flow for the Waselni apps, run with:
//
//   flutter-axi run < examples/ride-flow.mjs
//
// Prerequisites:
//   - Two devices booted (e.g. two simulators, or a simulator + an emulator)
//   - Both projects prepared once: flutter-axi setup driver <root> && flutter pub get
//   - Adjust roots/devices below.

const USER_ROOT = "/Users/cto/Developement/Waselni/Dev/waddeni-user";
const DRIVER_ROOT = "/Users/cto/Developement/Waselni/Dev/waselni-driver";
const USER_DEVICE = "00920CD6-2DFD-4A6F-9339-709459BBEE60";
const DRIVER_DEVICE = "2DB01DAD-93B7-415B-B533-DD882F69AFA8";

const user = apps.user;
const driver = apps.driver;

// Launch both apps (first launch compiles - be patient).
await user.launch(USER_ROOT, { device: USER_DEVICE });
console.log("user app up");
await driver.launch(DRIVER_ROOT, { device: DRIVER_DEVICE });
console.log("driver app up");

// Location + permissions without OS dialogs.
await user.permission("grant", "location");
await driver.permission("grant", "location");
await driver.gps(33.5138, 36.2765); // driver near Damascus city center
await user.gps(33.51, 36.27);

// Rider requests a ride.
console.log(await user.snapshot());
await user.tap("text:Request Ride"); // adapt to the real button text/key

// Driver receives and accepts the offer.
await driver.waitFor("New ride request", { timeout: 30000 });
await driver.tap("text:Accept");

// Rider sees the assignment; driver starts moving.
await user.waitFor("Driver assigned", { timeout: 30000 });
await driver.gps(33.512, 36.272);
await driver.wait(1000);
await driver.gps(33.5138, 36.2765);

console.log("ride flow OK");
