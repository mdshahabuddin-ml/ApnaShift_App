import 'api_client.dart';
import '../models/booking.dart';

/// Customer bookings — mirrors apnashift-backend/src/routes/bookings.js.
/// Server computes price; client values are never trusted.
class BookingsApi {
  final ApiClient _api;
  BookingsApi(this._api);

  Future<({List<Booking> items, int total})> list(
      {int page = 1, int limit = 20}) async {
    final d = await _api
        .get('/api/bookings', query: {'page': '$page', 'limit': '$limit'});
    final raw = (d['bookings'] ?? d['items'] ?? []) as List;
    final items = raw
        .whereType<Map>()
        .map((e) => Booking.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    return (
      items: items,
      total: int.tryParse('${d['total'] ?? items.length}') ?? items.length
    );
  }

  Future<Booking> get(String id) async {
    final d = await _api.get('/api/bookings/$id');
    final b = (d['booking'] ?? d) as Map;
    return Booking.fromJson(Map<String, dynamic>.from(b));
  }

  /// POST /api/bookings/estimate-price (public, rate-limited).
  Future<PriceEstimate> estimate({
    required double pickupLat,
    required double pickupLng,
    required double dropLat,
    required double dropLng,
    required String vehicleType,
    bool helperNeeded = false,
  }) async {
    final d = await _api.post('/api/bookings/estimate-price', body: {
      'pickup': {'lat': pickupLat, 'lng': pickupLng},
      'drop': {'lat': dropLat, 'lng': dropLng},
      'vehicle_type': vehicleType,
      'helper_needed': helperNeeded,
    });
    return PriceEstimate.fromJson(d);
  }

  /// POST /api/bookings (user). Optional Idempotency-Key header.
  Future<Booking> create({
    required String pickupAddress,
    required double pickupLat,
    required double pickupLng,
    required String dropAddress,
    required double dropLat,
    required double dropLng,
    required String vehicleType,
    bool helperNeeded = false,
    String paymentMethod = 'upi',
    String itemDescription = '',
    DateTime? scheduledTime,
    String? idempotencyKey,
  }) async {
    final d = await _api.post('/api/bookings',
        headers: idempotencyKey == null
            ? null
            : {'Idempotency-Key': idempotencyKey},
        body: {
          'pickup': {
            'address': pickupAddress,
            'lat': pickupLat,
            'lng': pickupLng
          },
          'drop': {'address': dropAddress, 'lat': dropLat, 'lng': dropLng},
          'vehicle_type': vehicleType,
          'helper_needed': helperNeeded,
          'payment_method': paymentMethod,
          'item_description': itemDescription,
          if (scheduledTime != null)
            'scheduled_time': scheduledTime.toUtc().toIso8601String(),
        });
    final b = (d['booking'] ?? d) as Map;
    return Booking.fromJson(Map<String, dynamic>.from(b));
  }

  Future<Booking> cancel(String id, String reason) async {
    final d = await _api
        .patch('/api/bookings/$id/cancel', body: {'reason': reason});
    final b = (d['booking'] ?? d) as Map;
    return Booking.fromJson(Map<String, dynamic>.from(b));
  }

  Future<Booking> dispute(String id, String reason) async {
    final d = await _api
        .post('/api/bookings/$id/flag-dispute', body: {'reason': reason});
    final b = (d['booking'] ?? d) as Map;
    return Booking.fromJson(Map<String, dynamic>.from(b));
  }

  Future<Map<String, dynamic>> submitRating(
      String id, int stars, String comment) async {
    final d = await _api.post('/api/bookings/$id/rating',
        body: {'stars': stars, 'comment': comment});
    return d['rating'] is Map
        ? Map<String, dynamic>.from(d['rating'] as Map)
        : <String, dynamic>{};
  }

  /// Returns rating map, or null when 404 not_rated.
  Future<Map<String, dynamic>?> getRating(String id) async {
    try {
      final d = await _api.get('/api/bookings/$id/rating');
      return d['rating'] is Map
          ? Map<String, dynamic>.from(d['rating'] as Map)
          : null;
    } on ApiException catch (e) {
      if (e.code == 'not_rated' || e.code == 'not_found') return null;
      rethrow;
    }
  }

  /// GET /api/bookings/:id/location?history=N — polling snapshot.
  Future<Map<String, dynamic>> location(String id,
      {int history = 10}) async {
    return _api.get('/api/bookings/$id/location',
        query: {'history': '$history'});
  }
}
