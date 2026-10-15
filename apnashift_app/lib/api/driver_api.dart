import 'api_client.dart';
import '../models/booking.dart';
import '../models/driver.dart';

/// Driver endpoints — mirrors apnashift-backend/src/routes/driver.js,
/// routes/drivers.js (register), routes/settlements.js (driver part).
/// All (except register) require driver role; verified gate on most.
class DriverApi {
  final ApiClient _api;
  DriverApi(this._api);

  /// POST /api/drivers/register — returns token + user + application.
  Future<({String token, DriverUser user, DriverApplication app})> register(
      Map<String, dynamic> fields) async {
    final d = await _api.post('/api/drivers/register', body: fields);
    return (
      token: (d['token'] ?? '').toString(),
      user: DriverUser.fromJson(
          Map<String, dynamic>.from(d['user'] as Map)),
      app: DriverApplication.fromJson(
          Map<String, dynamic>.from(d['application'] as Map)),
    );
  }

  Future<DriverUser> me() async {
    final d = await _api.get('/api/auth/me');
    return DriverUser.fromJson(
        Map<String, dynamic>.from(d['user'] as Map));
  }

  Future<Map<String, dynamic>> updateUpi(String? upiId) async {
    final d =
        await _api.patch('/api/driver/profile', body: {'upi_id': upiId});
    return Map<String, dynamic>.from(d['driver'] as Map);
  }

  Future<({List<Booking> items, int total})> available(
      {int page = 1, int limit = 20}) async {
    final d = await _api.get('/api/driver/bookings/available',
        query: {'page': '$page', 'limit': '$limit'});
    final raw = (d['bookings'] ?? []) as List;
    final items = raw
        .whereType<Map>()
        .map((e) => Booking.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    return (
      items: items,
      total: int.tryParse('${d['total'] ?? items.length}') ?? items.length
    );
  }

  Future<Booking> accept(String id) async {
    final d = await _api.patch('/api/driver/bookings/$id/accept');
    return Booking.fromJson(
        Map<String, dynamic>.from(d['booking'] as Map));
  }

  Future<void> decline(String id) async {
    await _api.post('/api/driver/bookings/$id/decline');
  }

  Future<Booking> advance(String id, String status) async {
    final d = await _api
        .patch('/api/driver/bookings/$id/status', body: {'status': status});
    return Booking.fromJson(
        Map<String, dynamic>.from(d['booking'] as Map));
  }

  Future<Booking> dispute(String id, String reason) async {
    final d = await _api.post('/api/driver/bookings/$id/flag-dispute',
        body: {'reason': reason});
    return Booking.fromJson(
        Map<String, dynamic>.from(d['booking'] as Map));
  }

  Future<({List<Booking> items, int total})> history(
      {int page = 1, int limit = 20}) async {
    final d = await _api.get('/api/driver/bookings',
        query: {'page': '$page', 'limit': '$limit'});
    final raw = (d['bookings'] ?? []) as List;
    final items = raw
        .whereType<Map>()
        .map((e) => Booking.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    return (
      items: items,
      total: int.tryParse('${d['total'] ?? items.length}') ?? items.length
    );
  }

  Future<Map<String, dynamic>> commissionDue() async {
    return _api.get('/api/driver/commission-due');
  }

  Future<Map<String, dynamic>> ledger() async {
    return _api.get('/api/driver/ledger');
  }

  Future<Map<String, dynamic>> weeklyEarnings() async {
    return _api.get('/api/driver/earnings/weekly');
  }

  Future<Map<String, dynamic>> postLocation(String bookingId,
      {required double lat,
      required double lng,
      double? accuracyM,
      double? speedMps,
      double? headingDeg}) async {
    return _api.post('/api/driver/bookings/$bookingId/location', body: {
      'lat': lat,
      'lng': lng,
      if (accuracyM != null) 'accuracy_m': accuracyM,
      if (speedMps != null) 'speed_mps': speedMps,
      if (headingDeg != null) 'heading_deg': headingDeg,
    });
  }

  Future<Map<String, dynamic>> confirmCash(String paymentId) async {
    return _api.post('/api/driver/payments/$paymentId/confirm-cash');
  }
}
