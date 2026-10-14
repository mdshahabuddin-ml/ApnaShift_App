// ApiClient + Session contract tests with MockClient (no network).
// Shapes mirror the real backend responses (ok:true, error codes).
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:apnashift_app/api/api_client.dart';
import 'package:apnashift_app/auth/session.dart';
import 'package:apnashift_app/auth/token_store.dart';

MockClient okClient() => MockClient((req) async {
      if (req.url.path == '/api/auth/login') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'token': 'tok123',
            'user': {'id': 'u1', 'name': 'Test User', 'phone': '9999999999', 'role': 'user'}
          }),
          200,
        );
      }
      if (req.url.path == '/api/auth/me') {
        if (req.headers['Authorization'] != 'Bearer tok123') {
          return http.Response(jsonEncode({'ok': false, 'error': 'invalid_token'}), 401);
        }
        return http.Response(
          jsonEncode({
            'ok': true,
            'user': {'id': 'u1', 'name': 'Test User', 'phone': '9999999999', 'role': 'user'}
          }),
          200,
        );
      }
      if (req.url.path == '/api/bookings') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'page': 1,
            'limit': 20,
            'total': 1,
            'bookings': [
              {
                'id': 'b1',
                'status': 'pending',
                'vehicle_type': 'Mini Truck',
                'price_rs': 500,
                'pickup_address': 'A',
                'drop_address': 'B',
                'created_at': '2026-10-14T00:00:00.000Z'
              }
            ]
          }),
          200,
        );
      }
      return http.Response('not found', 404);
    });

void main() {
  test('login stores token + user, bookings parse', () async {
    final s = Session(client: ApiClient(httpClient: okClient()), store: MemoryTokenStore());
    final err = await s.login(phone: '9999999999', password: 'Whatever123');
    expect(err, isNull);
    expect(s.loggedIn, isTrue);
    expect(s.user!.name, 'Test User');
    expect(await s.api.get('/api/bookings'), containsPair('total', 1));
  });

  test('bad credentials return code, no login', () async {
    final bad = MockClient((req) async => http.Response(jsonEncode({'ok': false, 'error': 'invalid_credentials'}), 401));
    final s = Session(client: ApiClient(httpClient: bad), store: MemoryTokenStore());
    final err = await s.login(phone: '9999999999', password: 'nope');
    expect(err, 'invalid_credentials');
    expect(s.loggedIn, isFalse);
  });

  test('restore with valid token loads me', () async {
    final store = MemoryTokenStore();
    await store.write('tok123');
    final s = Session(client: ApiClient(httpClient: okClient()), store: store);
    await s.restore();
    expect(s.loggedIn, isTrue);
    expect(s.user!.role, 'user');
  });

  test('restore with bad token logs out', () async {
    final store = MemoryTokenStore();
    await store.write('stale');
    final s = Session(client: ApiClient(httpClient: okClient()), store: store);
    await s.restore();
    expect(s.loggedIn, isFalse);
    expect(await store.read(), isNull);
  });
}
