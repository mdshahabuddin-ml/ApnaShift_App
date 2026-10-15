import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

/// OSM fallback tiles (website: OSM→CARTO fallback when Geoapify key
/// missing — same pattern, runtime template from /api/geo/config first).
const String kOsmTiles =
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/// Tap-to-pick map — booking.html "Choose on map" parity (mobile).
/// Returns {'lat', 'lng'} on confirm, null on cancel.
class MapPickerScreen extends StatefulWidget {
  final double initialLat;
  final double initialLng;
  final String title;
  final String tileTemplate;
  const MapPickerScreen(
      {super.key,
      required this.initialLat,
      required this.initialLng,
      this.title = 'Choose on map',
      this.tileTemplate = kOsmTiles});

  @override
  State<MapPickerScreen> createState() => _MapPickerScreenState();
}

class _MapPickerScreenState extends State<MapPickerScreen> {
  late double _lat = widget.initialLat;
  late double _lng = widget.initialLng;
  final _ctl = MapController();

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(children: [
        Expanded(
          child: FlutterMap(
            mapController: _ctl,
            options: MapOptions(
              initialCenter: LatLng(_lat, _lng),
              initialZoom: 14,
              onTap: (_, p) => setState(() {
                    _lat = p.latitude;
                    _lng = p.longitude;
                  }),
            ),
            children: [
              TileLayer(urlTemplate: widget.tileTemplate),
              MarkerLayer(markers: [
                Marker(
                    point: LatLng(_lat, _lng),
                    child: const Icon(Icons.location_pin,
                        color: Colors.red, size: 40)),
              ]),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Column(children: [
            Text(
                '${_lat.toStringAsFixed(5)}, ${_lng.toStringAsFixed(5)}',
                style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Cancel')),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ElevatedButton(
                    onPressed: () => Navigator.pop(
                        context, {'lat': _lat, 'lng': _lng}),
                    child: const Text('Use this location')),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }
}

/// Read-only trip map — tracking.html Leaflet parity (markers + route).
class TripMap extends StatelessWidget {
  final double? pickupLat;
  final double? pickupLng;
  final double? dropLat;
  final double? dropLng;
  final double? liveLat;
  final double? liveLng;
  final List<LatLng> route;
  final String tileTemplate;
  const TripMap(
      {super.key,
      this.pickupLat,
      this.pickupLng,
      this.dropLat,
      this.dropLng,
      this.liveLat,
      this.liveLng,
      this.route = const [],
      this.tileTemplate = kOsmTiles});

  @override
  Widget build(BuildContext context) {
    final pts = <LatLng>[];
    if (pickupLat != null && pickupLng != null) {
      pts.add(LatLng(pickupLat!, pickupLng!));
    }
    if (dropLat != null && dropLng != null) {
      pts.add(LatLng(dropLat!, dropLng!));
    }
    if (liveLat != null && liveLng != null) {
      pts.add(LatLng(liveLat!, liveLng!));
    }
    pts.addAll(route);
    if (pts.isEmpty) {
      return const SizedBox(
        height: 200,
        child: Center(child: Text('Map: no coordinates yet.')),
      );
    }
    double minLat = pts.first.latitude,
        maxLat = pts.first.latitude,
        minLng = pts.first.longitude,
        maxLng = pts.first.longitude;
    for (final p in pts) {
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
    final center =
        LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);
    return SizedBox(
      height: 260,
      child: FlutterMap(
        options: MapOptions(initialCenter: center, initialZoom: 13),
        children: [
          TileLayer(urlTemplate: tileTemplate),
          if (route.isNotEmpty)
            PolylineLayer(polylines: [
              Polyline(
                  points: route, color: Colors.blue, strokeWidth: 4),
            ]),
          MarkerLayer(markers: [
            if (pickupLat != null && pickupLng != null)
              Marker(
                  point: LatLng(pickupLat!, pickupLng!),
                  child: const Icon(Icons.location_pin,
                      color: Colors.green, size: 36)),
            if (dropLat != null && dropLng != null)
              Marker(
                  point: LatLng(dropLat!, dropLng!),
                  child: const Icon(Icons.location_pin,
                      color: Colors.red, size: 36)),
            if (liveLat != null && liveLng != null)
              Marker(
                  point: LatLng(liveLat!, liveLng!),
                  child: const Icon(Icons.local_shipping,
                      color: Colors.blue, size: 36)),
          ]),
        ],
      ),
    );
  }
}

/// Backend route geometry ([lng,lat] pairs) -> LatLng list.
List<LatLng> parseRouteGeometry(dynamic geometry) {
  final out = <LatLng>[];
  if (geometry is! List) return out;
  for (final p in geometry) {
    if (p is List && p.length >= 2) {
      final lng = double.tryParse('${p[0]}');
      final lat = double.tryParse('${p[1]}');
      if (lat != null &&
          lng != null &&
          lat >= -90 &&
          lat <= 90 &&
          lng >= -180 &&
          lng <= 180) {
        out.add(LatLng(lat, lng));
      }
    }
  }
  return out;
}
