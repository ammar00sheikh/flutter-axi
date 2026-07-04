#!/usr/bin/env bash
# Create the deterministic counter-app fixture the benchmark runs against:
# a stock `flutter create` app plus flutter-axi driver setup. Idempotent.
set -euo pipefail

BENCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="$BENCH_ROOT/fixtures"
APP_DIR="$FIXTURES_DIR/counter_app"

mkdir -p "$FIXTURES_DIR"

if [ ! -f "$APP_DIR/pubspec.yaml" ]; then
  echo "Creating counter app fixture..."
  (cd "$FIXTURES_DIR" && flutter create counter_app --platforms=ios,android --org dev.flutteraxi)
else
  echo "Counter app fixture already exists"
fi

echo "Enabling flutter-axi driver support..."
"$BENCH_ROOT/bin/flutter-axi" setup driver "$APP_DIR"

echo "Fetching dependencies..."
(cd "$APP_DIR" && flutter pub get)

echo "Fixture ready at $APP_DIR"
