import 'api_client.dart';

/// Geoapify proxy — mirrors apnashift-backend/src/routes/geo.js.
/// Auth required (any role); key never leaves backend.
class GeoPlace {
  final String formatted;
  final double lat;
  final double lng;

  const GeoPlace({required this.formatted, required this.lat, required this.lng});

  factory GeoPlace.fromJson(Map<String, dynamic> j) => GeoPlace(
        formatted: (j['formatted'] ?? j['address'] ?? '').toString(),
        lat: double.tryParse('${j['lat']}') ?? 0,
        lng: double.tryParse('${j['lng']}') ?? 0,
      );
}

class GeoApi {
  final ApiClient _api;
  GeoApi(this._api);

  Future<List<GeoPlace>> autocomplete(String text, {int limit = 5}) async {
    final d = await _api.get('/api/geo/autocomplete',
        query: {'text': text, 'limit': '$limit'});
    final raw = (d['results'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => GeoPlace.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<Map<String, dynamic>> route({
    required double pickupLat,
    required double pickupLng,
    required double dropLat,
    required double dropLng,
  }) async {
    return _api.get('/api/geo/route', query: {
      'pickup_lat': '$pickupLat',
      'pickup_lng': '$pickupLng',
      'drop_lat': '$dropLat',
      'drop_lng': '$dropLng',
    });
  }
}
