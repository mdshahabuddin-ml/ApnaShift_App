// UpdateCheckService + ApiClient X-App-Version contract tests (no network).
// Shapes mirror GET /api/app-updates/latest + 426 update_required bodies.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:apnashift_app/api/api_client.dart';
import 'package:apnashift_app/services/update_check_service.dart';

void main() {
  final savedVersion = ApiClient.appVersion;

  tearDown(() {
    ApiClient.appVersion = savedVersion;
    ApiClient.onServerError = null;
  });

  group('ApiClient X-App-Version + 426 hook', () {
    test('X-App-Version header tabhi jaata hai jab version set ho', () async {
      ApiClient.appVersion = '1.2.3';
      String? seen;
      final api = ApiClient(httpClient: MockClient((req) async {
        seen = req.headers['x-app-version'];
        return http.Response(jsonEncode({'ok': true}), 200);
      }));
      await api.get('/api/app-updates/latest');
      expect(seen, '1.2.3');

      ApiClient.appVersion = '';
      seen = 'sentinel';
      await api.get('/api/app-updates/latest');
      expect(seen, isNull);
    });

    test('426 update_required — details + onServerError hook', () async {
      ApiException? got;
      ApiClient.onServerError = (e) => got = e;
      final api = ApiClient(httpClient: MockClient((req) async {
        return http.Response(
          jsonEncode({
            'ok': false,
            'error': 'update_required',
            'latest_version': '2.0.0',
            'min_supported_version': '1.5.0',
            'update_url': 'https://example.com/app',
            'priority': 'high',
            'release_notes': 'Bug fixes',
            'message': 'Update zaroori hai',
          }),
          426,
        );
      }));
      await expectLater(api.get('/api/bookings'), throwsA(isA<ApiException>()));
      expect(got, isNotNull);
      expect(got!.code, 'update_required');
      expect(got!.status, 426);
      expect(got!.details?['latest_version'], '2.0.0');
      expect(got!.details?['update_url'], 'https://example.com/app');
    });

    test('non-426 errors hook ko nahi churate', () async {
      ApiException? got;
      ApiClient.onServerError = (e) => got = e;
      final api = ApiClient(httpClient: MockClient((req) async {
        return http.Response(
            jsonEncode({'ok': false, 'error': 'invalid_token'}), 401);
      }));
      await expectLater(
          api.get('/x'), throwsA(isA<ApiException>()));
      // hook sync hai; expectLater ke baad bhi null rehna chahiye
      expect(got, isNull);
    });
  });

  group('UpdateCheckService', () {
    UpdateCheckService svcWith(Map<String, dynamic> latestBody) {
      return UpdateCheckService.withApi(ApiClient(
        httpClient: MockClient((req) async {
          expect(req.url.path, '/api/app-updates/latest');
          return http.Response(jsonEncode({'ok': true, ...latestBody}), 200);
        }),
      ));
    }

    test('optional — pending set, dismiss ke baad same version dobara nahi',
        () async {
      final svc = svcWith({
        'action': 'optional',
        'latest_version': '1.1.0',
        'release_notes': 'Nayi cheezein',
        'update_url': 'https://example.com/dl',
        'priority': 'normal',
        'mandatory': false,
      });
      await svc.checkNow(force: true);
      expect(svc.pending?['action'], 'optional');
      expect(svc.pending?['latest_version'], '1.1.0');

      svc.dismissOptional();
      expect(svc.pending, isNull);

      await svc.checkNow(force: true);
      expect(svc.pending, isNull, reason: 'dismissed version session me dobara nahi');
    });

    test('required — dismissOptional clear nahi karta', () async {
      final svc = svcWith({
        'action': 'required',
        'latest_version': '2.0.0',
        'release_notes': 'Critical',
        'update_url': 'https://example.com/dl',
        'priority': 'high',
        'mandatory': true,
      });
      await svc.checkNow(force: true);
      expect(svc.pending?['action'], 'required');
      svc.dismissOptional();
      expect(svc.pending?['action'], 'required',
          reason: 'mandatory update kabhi dismiss nahi hoti');
    });

    test('none action par pending nahi banta', () async {
      final svc = svcWith({
        'action': 'none',
        'latest_version': null,
        'installed_version': '1.0.0',
      });
      await svc.checkNow(force: true);
      expect(svc.pending, isNull);
    });

    test('426 hook se bhi required pending banta hai', () async {
      final svc = UpdateCheckService.withApi(ApiClient(
        httpClient: MockClient((req) async =>
            http.Response(jsonEncode({'ok': true}), 200)),
      ));
      svc.init(); // ApiClient.onServerError = service hook
      final api = ApiClient(httpClient: MockClient((req) async {
        return http.Response(
          jsonEncode({
            'ok': false,
            'error': 'update_required',
            'latest_version': '3.0.0',
            'update_url': 'https://example.com/dl',
            'message': 'Gate ne roka',
          }),
          426,
        );
      }));
      await expectLater(api.get('/api/bookings/estimate-price'),
          throwsA(isA<ApiException>()));
      expect(svc.pending?['action'], 'required');
      expect(svc.pending?['latest_version'], '3.0.0');
      expect(svc.pending?['message'], 'Gate ne roka');
    });

    test('network fail par checkNow best-effort (pending nahi, throw nahi)',
        () async {
      final svc = UpdateCheckService.withApi(ApiClient(
        httpClient: MockClient((req) async => http.Response('oops', 500)),
      ));
      await svc.checkNow(force: true);
      expect(svc.pending, isNull);
    });

    test('throttle — do automatic checks me ek hi fetch', () async {
      var calls = 0;
      final svc = UpdateCheckService.withApi(ApiClient(
        httpClient: MockClient((req) async {
          calls++;
          return http.Response(
            jsonEncode({
              'ok': true,
              'action': 'optional',
              'latest_version': '1.1.0',
            }),
            200,
          );
        }),
      ));
      await svc.checkNow();
      await svc.checkNow(); // throttle ke andar — skip
      expect(calls, 1);
      await svc.checkNow(force: true);
      expect(calls, 2);
    });
  });
}
