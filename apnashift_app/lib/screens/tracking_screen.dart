import 'dart:async';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import '../api/api_client.dart';
import '../api/bookings_api.dart';
import '../api/geo_api.dart';
import '../auth/session.dart';
import '../models/booking.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'map_widgets.dart';

/// Live tracking — tracking.html Leaflet parity (flutter_map):
/// pickup/drop/live markers + server route polyline + status badge.
/// Polls GET /api/bookings/:id/location every 10s (website: 10s poll +
/// SSE fallback pattern).
class TrackingScreen extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  final String bookingId;
  const TrackingScreen(
      {super.key,
      required this.session,
      required this.settings,
      required this.bookingId});

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  late final BookingsApi _api = BookingsApi(widget.session.api);
  late final GeoApi _geo = GeoApi(widget.session.api);
  Map<String, dynamic>? _snap;
  Booking? _booking;
  List<LatLng> _route = [];
  String _tiles = kOsmTiles;
  String? _error;
  bool _loading = true;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _fetch();
    _poll = Timer.periodic(const Duration(seconds: 10), (_) => _fetch(silent: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _fetch({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final s = await _api.location(widget.bookingId, history: 10);
      if (_booking == null) {
        try {
          _booking = await _api.get(widget.bookingId);
        } catch (_) {}
        try {
          final cfg = await widget.session.api.get('/api/geo/config');
          final tpl = (cfg['tiles'] is Map)
              ? (cfg['tiles'] as Map)['template']
              : null;
          if (tpl is String && tpl.isNotEmpty) _tiles = tpl;
        } catch (_) {}
        if (_booking?.pickupLat != null &&
            _booking?.dropLat != null &&
            _route.isEmpty) {
          try {
            final r = await _geo.route(
                pickupLat: _booking!.pickupLat!,
                pickupLng: _booking!.pickupLng!,
                dropLat: _booking!.dropLat!,
                dropLng: _booking!.dropLng!);
            _route = parseRouteGeometry(r['geometry']);
          } catch (_) {}
        }
      }
      if (!mounted) return;
      setState(() {
        _snap = s;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      if (silent) return;
      setState(() {
        _error = e is ApiException
            ? 'Tracking failed (${e.code}). Try again.'
            : 'Unable to connect to the server.';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final tracking = _snap?['tracking'] is Map
        ? Map<String, dynamic>.from(_snap!['tracking'] as Map)
        : null;
    final driver = _snap?['driver'] is Map
        ? Map<String, dynamic>.from(_snap!['driver'] as Map)
        : null;
    final points = (_snap?['points'] ?? []) as List;
    final latest = points.isNotEmpty && points.first is Map
        ? Map<String, dynamic>.from(points.first as Map)
        : null;
    return AppScaffold(
      settings: widget.settings,
      title: 'Track live',
      body: RefreshIndicator(
        onRefresh: () => _fetch(),
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [
                    Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(_error!,
                            style: const TextStyle(color: Colors.red)))
                  ])
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      TripMap(
                        pickupLat: _booking?.pickupLat,
                        pickupLng: _booking?.pickupLng,
                        dropLat: _booking?.dropLat,
                        dropLng: _booking?.dropLng,
                        liveLat: latest == null
                            ? null
                            : double.tryParse(
                                '${latest['lat']}'),
                        liveLng: latest == null
                            ? null
                            : double.tryParse(
                                '${latest['lng']}'),
                        route: _route,
                        tileTemplate: _tiles,
                      ),
                      const SizedBox(height: 8),
                      Card(
                        child: ListTile(
                          title: Text(
                              'Status: ${_snap?['booking_status'] ?? '—'}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w800)),
                          subtitle: Text(
                              'Tracking: ${tracking?['state'] ?? '—'} • Updated: ${tracking?['last_updated'] ?? '—'} (${tracking?['age_s'] ?? '—'}s ago)'),
                        ),
                      ),
                      if (driver != null)
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.local_shipping),
                            title: Text('${driver['name'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700)),
                            subtitle: Text(
                                '${driver['vehicle_type'] ?? ''} • ${driver['vehicle_number'] ?? ''}'),
                          ),
                        ),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text('Live location',
                                    style: TextStyle(
                                        fontWeight: FontWeight.w800)),
                                const SizedBox(height: 6),
                                Text(latest == null
                                    ? 'No location yet — it will show once the driver shares it.'
                                    : 'Lat ${latest['lat']}, Lng ${latest['lng']} (±${latest['accuracy_m'] ?? '—'}m)'),
                                if (latest != null)
                                  Text(
                                      'Speed ${latest['speed_mps'] ?? '—'} m/s • Heading ${latest['heading_deg'] ?? '—'}°'),
                                Text(
                                    'Points: ${tracking?['points_count'] ?? points.length}'),
                              ]),
                        ),
                      ),
                      OutlinedButton(
                          onPressed: () => _fetch(),
                          child: const Text('Refresh ↻')),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }
}
