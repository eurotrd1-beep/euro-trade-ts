// Generates the migration parity fixture.
//
// Run with:  flutter test test/generate_golden_test.dart
//
// Output:    ../../packages/engine/golden/engine-golden.json
//
// This is not a test of correctness — it is a recorder. It captures what the
// Dart engine actually does today so the TypeScript port can be diffed against
// it. Whatever the Dart engine returns is, by definition, the expected value.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:golden_dart/services/signal_engine.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  test('record engine golden fixture', () {
    final fixture = buildGoldenFixture();

    final results = fixture['results'] as Map<String, dynamic>;
    final errors = fixture['errors'] as Map<String, String>;
    final total = fixture['indicatorCount'] as int;

    // ignore: avoid_print
    print('indicators: $total | computed: ${results.length} | threw: ${errors.length}');

    final out = File('../../packages/engine/golden/engine-golden.json');
    out.parent.createSync(recursive: true);
    out.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(fixture),
    );

    // ignore: avoid_print
    print('wrote ${out.absolute.path} (${out.lengthSync()} bytes)');

    // The fixture is only useful if the engine actually produced values.
    expect(results.length + errors.length, total);
    expect(results.length, greaterThan(0));
  });
}
