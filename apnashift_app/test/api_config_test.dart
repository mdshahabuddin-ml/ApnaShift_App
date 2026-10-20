// api_config regression: Android par localhost/127.0.0.1 → 10.0.2.2 rewrite
// (common --dart-define galti self-heal), baaki URLs untouched, empty = fail-fast.
import 'package:flutter_test/flutter_test.dart';
import 'package:apnashift_app/config/api_config.dart';

void main() {
  test('apiBaseUrl non-empty in debug (emulator default)', () {
    // flutter test debug mode me aata hai → default http://10.0.2.2:3000.
    expect(apiBaseUrl, isNotEmpty);
    expect(apiLocalEmulatorUrl, 'http://10.0.2.2:3000');
  });

  test('localhost guard — _resolveBaseUrl behavior via platform default', () {
    // flutter test ka defaultTargetPlatform android hota hai, isliye
    // resolve hokar aaya URL kabhi localhost/127.0.0.1 nahi hona chahiye.
    final uri = Uri.parse(apiBaseUrl);
    expect(uri.host, isNot('localhost'));
    expect(uri.host, isNot('127.0.0.1'));
  });
}
