import 'api_client.dart';
import '../models/booking.dart';

/// GET /api/bookings — apni bookings, newest first. {bookings:[], total}.
class BookingsApi {
  final ApiClient _api;
  BookingsApi(this._api);

  Future<({List<Booking> items, int total})> list({int page = 1, int limit = 20}) async {
    final d = await _api.get('/api/bookings', query: {'page': '$page', 'limit': '$limit'});
    final raw = (d['bookings'] ?? d['items'] ?? []) as List;
    final items = raw.whereType<Map>().map((e) => Booking.fromJson(Map<String, dynamic>.from(e))).toList();
    return (items: items, total: int.tryParse('${d['total'] ?? items.length}') ?? items.length);
  }

  Future<Booking> get(String id) async {
    final d = await _api.get('/api/bookings/$id');
    final b = (d['booking'] ?? d) as Map;
    return Booking.fromJson(Map<String, dynamic>.from(b));
  }
}
