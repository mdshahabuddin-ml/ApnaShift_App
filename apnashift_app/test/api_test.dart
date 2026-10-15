// ApiClient + Session contract tests with MockClient (no network).
// Shapes mirror the real backend responses (ok:true, error codes).
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:apnashift_app/api/api_client.dart';
import 'package:apnashift_app/api/admin_api.dart';
import 'package:apnashift_app/api/bookings_api.dart';
import 'package:apnashift_app/api/enterprise_api.dart';
import 'package:apnashift_app/api/geo_api.dart';
import 'package:apnashift_app/api/notifications_api.dart';
import 'package:apnashift_app/auth/driver_session.dart';
import 'package:apnashift_app/auth/session.dart';
import 'package:apnashift_app/auth/token_store.dart';
import 'package:apnashift_app/models/booking.dart';
import 'package:apnashift_app/models/driver.dart';
import 'package:apnashift_app/screens/map_widgets.dart';
import 'package:apnashift_app/services/sse.dart';

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
      if (req.url.path == '/api/bookings/estimate-price') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'vehicle_type': 'pickup',
            'distance_km': 5.2,
            'base_fare': 350,
            'distance_fare': 91,
            'helper_charge': 0,
            'total': 440,
            'estimate_min': 400,
            'estimate_max': 480,
          }),
          200,
        );
      }
      if (req.url.path == '/api/bookings' && req.method == 'POST') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'booking': {
              'id': 'b-new',
              'status': 'pending',
              'vehicle_type': 'pickup',
              'price_rs': 440,
              'pickup': {'address': 'A', 'lat': 22.7, 'lng': 75.8},
              'drop': {'address': 'B', 'lat': 22.73, 'lng': 75.86},
              'payment_method': 'upi',
              'created_at': '2026-10-14T00:00:00.000Z'
            }
          }),
          201,
        );
      }
      if (req.url.path == '/api/geo/autocomplete') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'results': [
              {'formatted': 'MG Road, Indore', 'lat': 22.7196, 'lng': 75.8577}
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/notifications/unread-count') {
        return http.Response(jsonEncode({'ok': true, 'unread': 2}), 200);
      }
      if (req.url.path == '/api/notifications') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'items': [
              {
                'id': 'n1',
                'title': 'Booking accepted',
                'body': 'Driver mil gaya',
                'booking_id': 'b1',
                'type': 'booking_accepted',
                'created_at': '2026-10-14T00:00:00.000Z'
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/drivers/register') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'token': 'dtok123',
            'user': {
              'id': 'd1',
              'name': 'Driver One',
              'phone': '9888888888',
              'role': 'driver',
              'vehicle_type': 'pickup',
              'vehicle_number': 'MP09AB1234',
              'is_verified': false,
              'application_ref': 'AS-2026-ABC123',
            },
            'application': {
              'id': 'AS-2026-ABC123',
              'status': 'PENDING_REVIEW',
              'registered_at': '2026-10-14T00:00:00.000Z'
            }
          }),
          201,
        );
      }
      if (req.url.path == '/api/driver/bookings/available') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'page': 1,
            'limit': 20,
            'total': 1,
            'bookings': [
              {
                'id': 'bj1',
                'status': 'pending',
                'vehicle_type': 'pickup',
                'price_rs': 440,
                'pickup': {'address': 'A', 'lat': 22.7, 'lng': 75.8},
                'drop': {'address': 'B', 'lat': 22.73, 'lng': 75.86},
                'estimate': {'earning_rs': 374, 'commission_rs': 66},
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/driver/commission-due') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'outstanding_rs': 100,
            'outstanding_paise': 10000,
            'commission_rs': 500,
            'settled_rs': 400,
            'limit_rs': 1500,
          }),
          200,
        );
      }
      if (req.url.path == '/api/driver/earnings/weekly') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'period': '7d',
            'completed_count': 3,
            'earnings_rs': 1500,
          }),
          200,
        );
      }
      if (req.url.path == '/api/driver/ledger') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'summary': {'outstanding_rs': 100},
            'payments': [
              {
                'id': 'p1',
                'booking_id': 'b1',
                'payment_method': 'cash',
                'payment_status': 'pending',
                'gross_rs': 440,
                'driver_earning_rs': 374,
                'platform_commission_rs': 66,
                'commission_pct': 15,
              }
            ],
            'settlements': [],
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/drivers') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'page': 1,
            'limit': 20,
            'total': 1,
            'drivers': [
              {
                'id': 'd1',
                'name': 'Driver One',
                'phone': '9888888888',
                'vehicle_type': 'Pickup',
                'vehicle_number': 'MP09AB1234',
                'is_verified': false,
                'is_active': true,
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/stats') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'today': {'bookings': 2},
            'total': {
              'completed': 10,
              'cancelled': 1,
              'revenue_rs': 5000
            }
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/bookings') {
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
                'vehicle_type': 'pickup',
                'price_rs': 440,
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/pricing-rules') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'rules': [
              {
                'vehicle_type': 'pickup',
                'base_rs': 350,
                'per_km_rs': 17.5,
                'helper_rs': 200,
                'commission_pct': 15
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/driver-balances') {        return http.Response(
          jsonEncode({
            'ok': true,
            'balances': [
              {
                'driver_id': 'd1',
                'name': 'Driver One',
                'outstanding_rs': 100,
                'commission_rs': 500,
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/enterprise/inquiries' &&
          req.method == 'POST') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'id': 'e1',
            'status': 'NEW',
          }),
          201,
        );
      }
      if (req.url.path.startsWith('/api/superadmin/customers/')) {
        return http.Response(
          jsonEncode({
            'ok': true,
            'customer': {
              'id': 'u1',
              'name': 'Test User',
              'phone': '9999999999',
              'created_at': '2026-01-01T00:00:00.000Z'
            },
            'status': 'active',
            'bookings': [],
            'lifetime': {'delivered_trips': 2, 'spent_rs': 880}
          }),
          200,
        );
      }
      if (req.url.path == '/api/superadmin/audit-logs') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'page': 1,
            'limit': 20,
            'total': 1,
            'logs': [
              {
                'id': 'l1',
                'action': 'booking.created',
                'entity': 'booking',
                'admin_name': 'Admin'
              }
            ]
          }),
          200,
        );
      }
      if (req.url.path == '/api/admin/adjustments') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'adjustment': {'id': 'a1'}
          }),
          201,
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

  test('estimate + create shape (Phase 2 customer)', () async {
    final api = BookingsApi(ApiClient(httpClient: okClient()));
    final q = await api.estimate(
        pickupLat: 22.7196,
        pickupLng: 75.8577,
        dropLat: 22.7296,
        dropLng: 75.8677,
        vehicleType: 'pickup');
    expect(q.total, 440);
    expect(q.min, 400);
    final b = await api.create(
        pickupAddress: 'A',
        pickupLat: 22.7,
        pickupLng: 75.8,
        dropAddress: 'B',
        dropLat: 22.73,
        dropLng: 75.86,
        vehicleType: 'pickup',
        idempotencyKey: 'k1');
    expect(b.id, 'b-new');
    expect(b.cancellable, isTrue);
  });

  test('booking flags (cancellable/trackable/rateable)', () async {
    final p = Booking.fromJson({'id': 'x', 'status': 'pending'});
    expect(p.cancellable, isTrue);
    expect(p.trackable, isFalse);
    final t = Booking.fromJson({
      'id': 'y',
      'status': 'accepted',
      'driver_id': 'd1',
    });
    expect(t.trackable, isTrue);
    final d = Booking.fromJson({'id': 'z', 'status': 'delivered'});
    expect(d.rateable, isTrue);
    expect(cancelReasons, contains('driver_issue'));
  });

  test('geo autocomplete + notifications (Phase 2)', () async {
    final client = ApiClient(httpClient: okClient());
    final places = await GeoApi(client).autocomplete('MG Road');
    expect(places.first.formatted, contains('MG Road'));
    final notifs = await NotificationsApi(client).list();
    expect(notifs.first.bookingId, 'b1');
    expect(await NotificationsApi(client).unreadCount(), 2);
  });

  test('driver register + available + due + weekly (Phase 3)', () async {
    final s = DriverSession.test(client: ApiClient(httpClient: okClient()));
    final err = await s.register({
      'name': 'Driver One',
      'phone': '9888888888',
      'password': 'Password123',
      'vehicle_type': 'pickup',
      'vehicle_number': 'MP09AB1234',
      'city': 'Indore',
      'license_number': 'MP0920200012345',
      'license_expiry': '2030-01-01',
      'service_city': 'Indore',
      'consent': true,
    });
    expect(err, isNull);
    expect(s.loggedIn, isTrue);
    expect(s.user!.isVerified, isFalse);
    expect(s.application!.status, 'PENDING_REVIEW');
    final avail = await s.driver.available();
    expect(avail.total, 1);
    expect(avail.items.first.estimate?['earning_rs'], 374);
    final due = await s.driver.commissionDue();
    expect(due['limit_rs'], 1500);
    final week = await s.driver.weeklyEarnings();
    expect(week['completed_count'], 3);
    final ledger = await s.driver.ledger();
    expect((ledger['payments'] as List).length, 1);
    expect(DriverUser.fromJson({'id': 'd1', 'role': 'driver'}).isDriver,
        isTrue);
  });

  test('admin console shapes (Phase 4)', () async {
    final api = AdminApi(ApiClient(httpClient: okClient()));
    final d = await api.drivers(status: 'pending');
    expect(d.total, 1);
    expect(d.items.first['phone'], '9888888888');
    final s = await api.stats();
    expect(s['ok'], isTrue);
    final b = await api.bookings();
    expect(b.total, 1);
    final rules = await api.pricingRules();
    expect(rules.first['vehicle_type'], 'pickup');
    final bals = await api.driverBalances();
    expect(bals.first['outstanding_rs'], 100);
  });

  test('superadmin console shapes (Phase 5)', () async {
    final api = AdminApi(ApiClient(httpClient: okClient()));
    final cu = await api.superadminCustomer('u1');
    expect(
        (cu['customer'] as Map)['phone'], '9999999999');
    expect((cu['lifetime'] as Map)['delivered_trips'], 2);
    final logs = await api.auditLogs(action: 'booking.created');
    expect(logs.first['entity'], 'booking');
    expect(await api.auditLogsTotal(), 1);
    final adj = await api.createAdjustment(
        paymentId: 'p1',
        commissionDeltaPaise: 100,
        reason: 'test correction');
    expect(adj['ok'], isTrue);
  });

  test('enterprise inquiry + validation + route parse (Phase 6)', () async {
    final api = EnterpriseApi(ApiClient(httpClient: okClient()));
    final r = await api.submit({
      'full_name': 'Test Biz',
      'email': 'biz@example.com',
      'phone': '9999999999',
      'company_name': 'Biz Pvt Ltd',
      'consent': true,
    });
    expect(r['status'], 'NEW');
    expect(
        validateEnterprise({
          'full_name': 'T',
          'email': 'bad',
          'phone': '123',
          'company_name': '',
          'consent': false,
        }),
        isNotNull);
    expect(
        validateEnterprise({
          'full_name': 'Test Biz',
          'email': 'biz@example.com',
          'phone': '+919999999999',
          'company_name': 'Biz Pvt Ltd',
          'website': 'nodot',
          'consent': true,
        }),
        contains('website'));
    expect(normalizeEnterprisePhone('+919999999999'), '9999999999');
    final pts = parseRouteGeometry([
      [75.8577, 22.7196],
      ['bad', 'data'],
      [75.8677, 22.7296],
    ]);
    expect(pts.length, 2);
  });

  test('SSE block parser (live feeds)', () {
    final nb = parseSseBlock(
        'event: new_booking\ndata: {"booking_id":"b1"}');
    expect(nb!.event, 'new_booking');
    expect(nb.data, contains('b1'));
    final ready =
        parseSseBlock('event: ready\ndata: {"vehicle_type":"pickup"}');
    expect(ready!.event, 'ready');
    expect(parseSseBlock(': ping'), isNull);
    expect(parseSseBlock(''), isNull);
    final notif = parseSseBlock(
        'event: notification\ndata: {"id":"n1"}');
    expect(notif!.event, 'notification');
  });
}
