import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api/api_client.dart';
import '../api/bookings_api.dart';
import '../api/geo_api.dart';
import '../auth/session.dart';
import '../models/booking.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'booking_detail_screen.dart';
import 'map_widgets.dart';

/// Booking create — apnashift-frontend/booking.html parity (mobile layout).
/// Address + lat/lng (suggestion or manual), date/time optional, vehicle,
/// UPI/Cash, helper, item desc. Get Estimate -> fare, Confirm -> detail.
/// Validations mirror backend zod (validation/booking.js).
class CreateBookingScreen extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  const CreateBookingScreen(
      {super.key, required this.session, required this.settings});

  @override
  State<CreateBookingScreen> createState() => _CreateBookingScreenState();
}

class _CreateBookingScreenState extends State<CreateBookingScreen> {
  final _pickupAddr = TextEditingController(text: '');
  final _pickupLat = TextEditingController(text: '22.7196');
  final _pickupLng = TextEditingController(text: '75.8577');
  final _dropAddr = TextEditingController(text: '');
  final _dropLat = TextEditingController(text: '22.7296');
  final _dropLng = TextEditingController(text: '75.8677');
  final _item = TextEditingController();
  DateTime? _date;
  TimeOfDay? _time;
  String _vehicle = 'pickup';
  String _pay = 'upi';
  bool _helper = false;

  PriceEstimate? _quote;
  String? _error;
  String? _fieldError;
  bool _estimating = false;
  bool _booking = false;
  List<GeoPlace> _pickSug = [];
  List<GeoPlace> _dropSug = [];
  Timer? _deb;
  // Last suggestion-picked address text (per field). Address edit karne
  // par coords stale ho jate hain — ye track karke warning dikhate hain.
  String? _pickPicked;
  String? _dropPicked;

  late final BookingsApi _api = BookingsApi(widget.session.api);
  late final GeoApi _geo = GeoApi(widget.session.api);
  String _tiles = kOsmTiles;

  @override
  void initState() {
    super.initState();
    widget.session.api.get('/api/geo/config').then((cfg) {
      final tpl =
          (cfg['tiles'] is Map) ? (cfg['tiles'] as Map)['template'] : null;
      if (tpl is String && tpl.isNotEmpty && mounted) {
        setState(() => _tiles = tpl);
      }
    }).catchError((_) => <String, dynamic>{});
  }

  Future<void> _pickOnMap(bool pickup) async {
    final curLat = double.tryParse(
            (pickup ? _pickupLat : _dropLat).text.trim()) ??
        22.7196;
    final curLng = double.tryParse(
            (pickup ? _pickupLng : _dropLng).text.trim()) ??
        75.8577;
    final r = await Navigator.of(context).push<Map<String, double>>(
      MaterialPageRoute(
          builder: (_) => MapPickerScreen(
              initialLat: curLat,
              initialLng: curLng,
              title: pickup ? 'Pickup on map' : 'Drop on map',
              tileTemplate: _tiles)),
    );
    if (r != null && mounted) {
      setState(() {
        if (pickup) {
          _pickupLat.text = '${r['lat']}';
          _pickupLng.text = '${r['lng']}';
          // Map se confirm kiya — current address text isi pin ke saath.
          _pickPicked = _pickupAddr.text.trim();
          _pickSug = [];
        } else {
          _dropLat.text = '${r['lat']}';
          _dropLng.text = '${r['lng']}';
          _dropPicked = _dropAddr.text.trim();
          _dropSug = [];
        }
        _quote = null;
      });
    }
  }

  /// Address edit hua par coords purane suggestion ke hain → stale warning.
  bool get _pickStale =>
      _pickPicked != null && _pickupAddr.text.trim() != _pickPicked;
  bool get _dropStale =>
      _dropPicked != null && _dropAddr.text.trim() != _dropPicked;

  @override
  void dispose() {
    _deb?.cancel();
    _pickupAddr.dispose();
    _pickupLat.dispose();
    _pickupLng.dispose();
    _dropAddr.dispose();
    _dropLat.dispose();
    _dropLng.dispose();
    _item.dispose();
    super.dispose();
  }

  double? _parseLat(String v) {
    final d = double.tryParse(v.trim());
    if (d == null || d < -90 || d > 90) return null;
    return d;
  }

  double? _parseLng(String v) {
    final d = double.tryParse(v.trim());
    if (d == null || d < -180 || d > 180) return null;
    return d;
  }

  /// Straight-line distance (haversine). Server road-distance (~1.3x)
  /// use karta hai — ye sirf early warning ke liye hai.
  static double _haversineKm(
      double lat1, double lng1, double lat2, double lng2) {
    const r = 6371.0;
    const rad = pi / 180.0;
    final dLat = (lat2 - lat1) * rad;
    final dLng = (lng2 - lng1) * rad;
    final a = sin(dLat / 2) * sin(dLat / 2) +
        cos(lat1 * rad) * cos(lat2 * rad) * sin(dLng / 2) * sin(dLng / 2);
    return r * 2 * asin(sqrt(a.clamp(0.0, 1.0)));
  }

  /// Pickup–drop straight distance, ya null jab coords invalid hon.
  double? _distanceKm() {
    final plat = _parseLat(_pickupLat.text);
    final plng = _parseLng(_pickupLng.text);
    final dlat = _parseLat(_dropLat.text);
    final dlng = _parseLng(_dropLng.text);
    if (plat == null || plng == null || dlat == null || dlng == null) {
      return null;
    }
    return _haversineKm(plat, plng, dlat, dlng);
  }

  String? _validate() {
    if (_pickupAddr.text.trim().length < 3) {
      return 'Pickup address kam se kam 3 akshar.';
    }
    if (_pickupAddr.text.trim().length > 300) {
      return 'Pickup address 300 akshar se zyada nahi.';
    }
    if (_parseLat(_pickupLat.text) == null) {
      return 'Pickup lat -90..90 number ho (suggestion chuno ya manual likho).';
    }
    if (_parseLng(_pickupLng.text) == null) {
      return 'Pickup lng -180..180 number ho.';
    }
    if (_dropAddr.text.trim().length < 3) {
      return 'Drop address kam se kam 3 akshar.';
    }
    if (_dropAddr.text.trim().length > 300) {
      return 'Drop address 300 akshar se zyada nahi.';
    }
    if (_parseLat(_dropLat.text) == null) return 'Drop lat -90..90 number ho.';
    if (_parseLng(_dropLng.text) == null) return 'Drop lng -180..180 number ho.';
    final dist = _distanceKm();
    if (dist != null && dist * 1.3 > 500) {
      return 'Pickup–drop seedhi doori ~${dist.toStringAsFixed(0)} km hai (road se aur zyada) — 500km single-city limit cross. Dono pins same city me check karo (map par dekho).';
    }
    if (!['pickup', 'mini_truck', 'mini_tractor'].contains(_vehicle)) {
      return 'Vehicle pickup, mini_truck ya mini_tractor ho.';
    }
    if (_item.text.trim().length > 500) {
      return 'Item detail 500 akshar se zyada nahi.';
    }
    if (_date != null) {
      final now = DateTime.now().subtract(const Duration(minutes: 1));
      var sched = DateTime(_date!.year, _date!.month, _date!.day);
      if (_time != null) {
        sched = DateTime(_date!.year, _date!.month, _date!.day, _time!.hour,
            _time!.minute);
      }
      if (sched.isBefore(now)) return 'Date future me ho (past date nahi).';
    }
    return null;
  }

  DateTime? _scheduledAt() {
    if (_date == null) return null;
    if (_time == null) {
      // Date-only: noon bhejo (midnight UTC-shift me past ho sakta hai —
      // same-day midnight + IST->UTC shift = kal ka past -> backend 400).
      return DateTime(_date!.year, _date!.month, _date!.day, 12);
    }
    return DateTime(
        _date!.year, _date!.month, _date!.day, _time!.hour, _time!.minute);
  }

  Future<void> _suggest(String text, bool pickup) async {
    _deb?.cancel();
    if (text.trim().length < 3) {
      setState(() {
        if (pickup) {
          _pickSug = [];
        } else {
          _dropSug = [];
        }
      });
      return;
    }
    _deb = Timer(const Duration(milliseconds: 500), () async {
      try {
        final r = await _geo.autocomplete(text.trim(), limit: 5);
        if (!mounted) return;
        setState(() {
          if (pickup) {
            _pickSug = r;
          } else {
            _dropSug = r;
          }
        });
      } catch (_) {
        // quota/offline — manual lat/lng se kaam chalega.
      }
    });
  }

  Future<void> _estimate() async {
    final v = _validate();
    if (v != null) {
      setState(() {
        _fieldError = v;
        _error = null;
      });
      return;
    }
    setState(() {
      _estimating = true;
      _fieldError = null;
      _error = null;
    });
    try {
      final q = await _api.estimate(
        pickupLat: _parseLat(_pickupLat.text)!,
        pickupLng: _parseLng(_pickupLng.text)!,
        dropLat: _parseLat(_dropLat.text)!,
        dropLng: _parseLng(_dropLng.text)!,
        vehicleType: _vehicle,
        helperNeeded: _helper,
      );
      if (!mounted) return;
      setState(() {
        _quote = q;
        _estimating = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _estimating = false;
        _error = _friendly(e);
      });
    }
  }

  Future<void> _confirm() async {
    final v = _validate();
    if (v != null) {
      setState(() {
        _fieldError = v;
        _error = null;
      });
      return;
    }
    if (_quote == null) {
      setState(() => _fieldError = 'Pehle Get Estimate dabao — sahi fare dekh ke confirm karo.');
      return;
    }
    setState(() {
      _booking = true;
      _error = null;
    });
    try {
      // Idempotency-Key NAHI bhejte (legacy direct-insert flow).
      // Reason: prod backend purana hai — key wali table/route missing par
      // 500 server_error aata hai, bina key ke create succeed hota hai.
      // Double-tap double-booking se bachne ke liye button _booking me
      // disabled rehta hai.
      final b = await _api.create(
        pickupAddress: _pickupAddr.text.trim(),
        pickupLat: _parseLat(_pickupLat.text)!,
        pickupLng: _parseLng(_pickupLng.text)!,
        dropAddress: _dropAddr.text.trim(),
        dropLat: _parseLat(_dropLat.text)!,
        dropLng: _parseLng(_dropLng.text)!,
        vehicleType: _vehicle,
        helperNeeded: _helper,
        paymentMethod: _pay,
        itemDescription: _item.text.trim(),
        scheduledTime: _scheduledAt(),
      );
      if (!mounted) return;
      setState(() => _booking = false);
      Navigator.of(context).push(
        MaterialPageRoute(
            builder: (_) => BookingDetailScreen(
                session: widget.session,
                settings: widget.settings,
                bookingId: b.id)),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _booking = false;
        _error = _friendly(e);
      });
    }
  }

  static String _friendly(Object e) {
    if (e is ApiException) {
      switch (e.code) {
        case 'validation_failed':
          return 'Details check karo (address 3+, lat/lng range, vehicle, date future). Date hata ke bhi try karo.';
        case 'distance_too_far':
          return 'Distance 500km se zyada — dono pins same city me hain ye map/suggestion se verify karo. (Seedhi doori screen par dikhti hai.)';
        case 'unsupported_payment_method':
          return 'Sirf UPI/Cash allowed (online gateway nahi hai).';
        case 'too_many_attempts':
          return 'Bahut tries — 15 min ruk ke retry karo.';
        case 'invalid_token':
        case 'missing_token':
          return 'Session khatm — dobara login karo.';
        case 'server_error':
          return 'Server error — booking save nahi hui. My Bookings me check karo (kabhi ban jati hai), date hata ke retry karo, ya backend update chahiye (prod purana hai).';
        default:
          return 'Booking fail (${e.code}). Retry karo.';
      }
    }
    return 'Server se baat nahi ho payi. Net + server check karo.';
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Book a Vehicle',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_fieldError != null)
            Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(_fieldError!,
                    style: const TextStyle(color: Colors.red))),
          if (_error != null)
            Container(
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(_error!,
                    style: const TextStyle(color: Colors.red))),
          const SizedBox(height: 8),
          TextField(
            controller: _pickupAddr,
            decoration: const InputDecoration(
                labelText: 'Pickup address *',
                hintText: 'Example: 12 MG Road, Indore',
                border: OutlineInputBorder()),
            onChanged: (v) {
              if (_pickPicked != null && v.trim() != _pickPicked) {
                setState(() => _pickPicked = null);
              }
              _suggest(v, true);
            },
          ),
          if (_pickStale)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                  '⚠️ Address badla hai — suggestion se dobara chuno ya map par pin check karo.',
                  style: TextStyle(color: Colors.orange, fontSize: 12)),
            ),
          if (_pickSug.isNotEmpty)
            ..._pickSug.map((p) => ListTile(
                  dense: true,
                  leading: const Icon(Icons.location_on,
                      size: 20, color: Colors.grey),
                  title: Text(p.formatted,
                      style: const TextStyle(fontSize: 13)),
                  subtitle: Text(
                      '${p.lat.toStringAsFixed(4)}, ${p.lng.toStringAsFixed(4)}',
                      style: const TextStyle(
                          fontSize: 11, color: Colors.grey)),
                  onTap: () {
                    _pickupAddr.text = p.formatted;
                    _pickupLat.text = '${p.lat}';
                    _pickupLng.text = '${p.lng}';
                    setState(() {
                      _pickPicked = p.formatted;
                      _pickSug = [];
                      _quote = null;
                    });
                  },
                )),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
                child: TextField(
                    controller: _pickupLat,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[-0-9.]'))
                    ],
                    decoration: const InputDecoration(
                        labelText: 'Pickup lat *',
                        border: OutlineInputBorder()))),
            const SizedBox(width: 8),
            Expanded(
                child: TextField(
                    controller: _pickupLng,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[-0-9.]'))
                    ],
                    decoration: const InputDecoration(
                        labelText: 'Pickup lng *',
                        border: OutlineInputBorder()))),
          ]),
          OutlinedButton.icon(
            icon: const Icon(Icons.map, size: 16),
            label: const Text('Choose pickup on map'),
            onPressed: () => _pickOnMap(true),
          ),
          Builder(builder: (_) {
            final plat = _parseLat(_pickupLat.text);
            final plng = _parseLng(_pickupLng.text);
            if (plat == null || plng == null) {
              return const Text('📍 No location chosen yet.',
                  style: TextStyle(fontSize: 12, color: Colors.grey));
            }
            return Text(
                '📍 ${plat.toStringAsFixed(4)}, ${plng.toStringAsFixed(4)}',
                style:
                    const TextStyle(fontSize: 12, color: Colors.grey));
          }),
          const SizedBox(height: 12),
          TextField(
            controller: _dropAddr,
            decoration: const InputDecoration(
                labelText: 'Drop address *',
                hintText: 'Example: 45 AB Road, Indore',
                border: OutlineInputBorder()),
            onChanged: (v) {
              if (_dropPicked != null && v.trim() != _dropPicked) {
                setState(() => _dropPicked = null);
              }
              _suggest(v, false);
            },
          ),
          if (_dropStale)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                  '⚠️ Address badla hai — suggestion se dobara chuno ya map par pin check karo.',
                  style: TextStyle(color: Colors.orange, fontSize: 12)),
            ),
          if (_dropSug.isNotEmpty)
            ..._dropSug.map((p) => ListTile(
                  dense: true,
                  leading: const Icon(Icons.location_on,
                      size: 20, color: Colors.grey),
                  title: Text(p.formatted,
                      style: const TextStyle(fontSize: 13)),
                  subtitle: Text(
                      '${p.lat.toStringAsFixed(4)}, ${p.lng.toStringAsFixed(4)}',
                      style: const TextStyle(
                          fontSize: 11, color: Colors.grey)),
                  onTap: () {
                    _dropAddr.text = p.formatted;
                    _dropLat.text = '${p.lat}';
                    _dropLng.text = '${p.lng}';
                    setState(() {
                      _dropPicked = p.formatted;
                      _dropSug = [];
                      _quote = null;
                    });
                  },
                )),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
                child: TextField(
                    controller: _dropLat,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[-0-9.]'))
                    ],
                    decoration: const InputDecoration(
                        labelText: 'Drop lat *',
                        border: OutlineInputBorder()))),
            const SizedBox(width: 8),
            Expanded(
                child: TextField(
                    controller: _dropLng,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[-0-9.]'))
                    ],
                    decoration: const InputDecoration(
                        labelText: 'Drop lng *',
                        border: OutlineInputBorder()))),
          ]),
          OutlinedButton.icon(
            icon: const Icon(Icons.map, size: 16),
            label: const Text('Choose drop on map'),
            onPressed: () => _pickOnMap(false),
          ),
          Builder(builder: (_) {
            final dlat = _parseLat(_dropLat.text);
            final dlng = _parseLng(_dropLng.text);
            if (dlat == null || dlng == null) {
              return const Text('📍 No location chosen yet.',
                  style: TextStyle(fontSize: 12, color: Colors.grey));
            }
            return Text(
                '📍 ${dlat.toStringAsFixed(4)}, ${dlng.toStringAsFixed(4)}',
                style:
                    const TextStyle(fontSize: 12, color: Colors.grey));
          }),
          Builder(builder: (_) {
            final dist = _distanceKm();
            if (dist == null) return const SizedBox.shrink();
            final road = dist * 1.3;
            final over = road > 500;
            return Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                  'Pickup–drop seedhi doori ~${dist.toStringAsFixed(0)} km (road ~${road.toStringAsFixed(0)} km)${over ? ' — 500km limit cross!' : ''}',
                  style: TextStyle(
                      fontSize: 12,
                      color: over ? Colors.red : Colors.green,
                      fontWeight:
                          over ? FontWeight.w700 : FontWeight.w400)),
            );
          }),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
                child: OutlinedButton(
                    onPressed: () async {
                      final d = await showDatePicker(
                          context: context,
                          firstDate: DateTime.now(),
                          lastDate: DateTime.now()
                              .add(const Duration(days: 30)),
                          initialDate: _date ?? DateTime.now());
                      if (d != null) setState(() => _date = d);
                    },
                    child: Text(_date == null
                        ? 'Date (optional)'
                        : '${_date!.day}/${_date!.month}/${_date!.year}'))),
            const SizedBox(width: 8),
            Expanded(
                child: OutlinedButton(
                    onPressed: () async {
                      final t = await showTimePicker(
                          context: context, initialTime: TimeOfDay.now());
                      if (t != null) setState(() => _time = t);
                    },
                    child: Text(_time == null
                        ? 'Time (optional)'
                        : _time!.format(context)))),
          ]),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            value: _vehicle,
            decoration: const InputDecoration(
                labelText: 'Vehicle *', border: OutlineInputBorder()),
            items: const [
              DropdownMenuItem(
                  value: 'pickup', child: Text('Pickup — small items')),
              DropdownMenuItem(
                  value: 'mini_truck',
                  child: Text('Mini Truck — household')),
              DropdownMenuItem(
                  value: 'mini_tractor',
                  child: Text('Mini Tractor — heavy')),
            ],
            onChanged: (v) => setState(() {
              _vehicle = v ?? 'pickup';
              _quote = null;
            }),
          ),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
                child: RadioListTile<String>(
                    title: const Text('UPI'),
                    value: 'upi',
                    groupValue: _pay,
                    onChanged: (v) => setState(() => _pay = v ?? 'upi'))),
            Expanded(
                child: RadioListTile<String>(
                    title: const Text('Cash'),
                    value: 'cash',
                    groupValue: _pay,
                    onChanged: (v) => setState(() => _pay = v ?? 'upi'))),
          ]),
          CheckboxListTile(
              title: const Text('Helper chahiye (+charge)'),
              value: _helper,
              onChanged: (v) => setState(() {
                    _helper = v ?? false;
                    _quote = null;
                  })),
          TextField(
            controller: _item,
            maxLength: 500,
            maxLines: 2,
            decoration: const InputDecoration(
                labelText: 'Item detail (optional)',
                border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: _estimating ? null : _estimate,
            child: Text(_estimating ? 'Ruko…' : 'Get Estimate — See Fare'),
          ),
          if (_quote != null)
            Card(
              margin: const EdgeInsets.symmetric(vertical: 10),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(children: [
                  _fareRow('Distance', '${_quote!.distanceKm} km'),
                  _fareRow('Base', '₹${_quote!.baseFare.toStringAsFixed(0)}'),
                  _fareRow('Distance fare',
                      '₹${_quote!.distanceFare.toStringAsFixed(0)}'),
                  _fareRow('Helper',
                      '₹${_quote!.helperCharge.toStringAsFixed(0)}'),
                  const Divider(),
                  _fareRow('Total', '₹${_quote!.total.toStringAsFixed(0)}',
                      bold: true),
                  Text(
                      'Range ₹${_quote!.min.toStringAsFixed(0)} – ₹${_quote!.max.toStringAsFixed(0)} (±10%)',
                      style: const TextStyle(
                          fontSize: 12, color: Colors.grey)),
                ]),
              ),
            ),
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: _booking ? null : _confirm,
            child: Text(_booking ? 'Ruko…' : 'Confirm Booking →'),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _fareRow(String k, String v, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Text(k),
            const Spacer(),
            Text(v,
                style: TextStyle(
                    fontWeight: bold ? FontWeight.w800 : FontWeight.w600)),
          ],
        ),
      );
}
