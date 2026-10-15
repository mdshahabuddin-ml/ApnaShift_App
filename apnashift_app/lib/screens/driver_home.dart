import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../api/api_client.dart';
import '../api/driver_api.dart';
import '../auth/driver_session.dart';
import '../models/booking.dart';
import '../services/sse.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';

/// Driver console — driver-dashboard.html parity (mobile tabs).
/// Jobs (available + accept/decline + due gate), Trips (active status
/// machine + 5s GPS share + history), Money (due/ledger/weekly/cash),
/// Account (verified badge + UPI save + logout).
class DriverHome extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const DriverHome({super.key, required this.session, required this.settings});

  @override
  State<DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<DriverHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _tab, children: [
        _JobsTab(session: widget.session, settings: widget.settings),
        _TripsTab(session: widget.session, settings: widget.settings),
        _MoneyTab(session: widget.session, settings: widget.settings),
        _DriverAccountTab(
            session: widget.session, settings: widget.settings),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.work), label: 'Jobs'),
          NavigationDestination(
              icon: Icon(Icons.local_shipping), label: 'Trips'),
          NavigationDestination(
              icon: Icon(Icons.account_balance_wallet), label: 'Money'),
          NavigationDestination(
              icon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}

String _friendly(Object e) {
  if (e is ApiException) {
    switch (e.code) {
      case 'commission_limit_exceeded':
        return 'Commission due limit cross — pehle hisab clear karo.';
      case 'already_accepted':
        return 'Ye trip kisi aur ne le li / cancel ho gayi.';
      case 'already_declined':
        return 'Already declined.';
      case 'driver_unverified':
        return 'Application PENDING — admin verify karega, tab tak jobs nahi.';
      case 'driver_inactive':
        return 'Account deactivated — support se baat karo.';
      case 'invalid_transition':
        return 'Ye step abhi allowed nahi.';
      case 'tracking_not_active':
        return 'Tracking sirf accepted/arrived/in_transit par.';
      case 'too_many_attempts':
        return 'Bahut requests — thoda ruk ke retry karo.';
      case 'not_delivered':
        return 'Sirf delivered trip par.';
      case 'validation_failed':
        return 'Details check karo.';
      default:
        return 'Fail (${e.code}). Retry karo.';
    }
  }
  return 'Server se baat nahi ho payi.';
}

// ---------------- Jobs ----------------

class _JobsTab extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const _JobsTab({required this.session, required this.settings});

  @override
  State<_JobsTab> createState() => _JobsTabState();
}

class _JobsTabState extends State<_JobsTab> {
  late final DriverApi _api = widget.session.driver;
  List<Booking> _items = [];
  int _total = 0;
  Map<String, dynamic>? _due;
  Map<String, dynamic>? _week;
  String? _error;
  bool _loading = true;
  bool _busy = false;
  bool _live = false;
  StreamSubscription<SseEvent>? _sse;
  Timer? _fallback;

  @override
  void initState() {
    super.initState();
    _load();
    // Live new-booking feed (own vehicle type) + 30s poll fallback —
    // driver-dashboard.html SSE + fallback parity.
    _sse = openSse(widget.session.api, '/api/driver/bookings/stream')
        .listen((ev) {
      if (!mounted) return;
      if (ev.event == 'ready') {
        setState(() => _live = true);
      } else if (ev.event == 'new_booking') {
        _quietRefresh();
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('🔔 Nayi trip aayi — list refresh ho gayi.')));
      }
    });
    _fallback =
        Timer.periodic(const Duration(seconds: 30), (_) => _quietRefresh());
  }

  @override
  void dispose() {
    _sse?.cancel();
    _fallback?.cancel();
    super.dispose();
  }

  /// Bina spinner flash ke list refresh (SSE/poll driven).
  Future<void> _quietRefresh() async {
    if (!mounted || _loading) return;
    try {
      final avail = await _api.available(limit: 20);
      if (!mounted) return;
      setState(() {
        _items = avail.items;
        _total = avail.total;
      });
    } catch (_) {
      // fallback chup-chaap fail — manual refresh ab bhi hai.
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final avail = await _api.available(limit: 20);
      Map<String, dynamic>? due;
      Map<String, dynamic>? week;
      try {
        due = await _api.commissionDue();
      } catch (_) {}
      try {
        week = await _api.weeklyEarnings();
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _items = avail.items;
        _total = avail.total;
        _due = due;
        _week = week;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _friendly(e);
        _loading = false;
      });
    }
  }

  Future<void> _accept(Booking b) async {
    setState(() => _busy = true);
    try {
      await _api.accept(b.id);
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Trip accepted — Trips tab dekho.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  Future<void> _decline(Booking b) async {
    setState(() => _busy = true);
    try {
      await _api.decline(b.id);
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Jobs (${_total})${_live ? ' • live' : ''}',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
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
                    padding: const EdgeInsets.all(12),
                    children: [
                      if (_due != null)
                        Card(
                          child: ListTile(
                            title: Text(
                                'Due ₹${_due!['outstanding_rs'] ?? '—'} / limit ₹${_due!['limit_rs'] ?? '—'}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w800)),
                            subtitle: Text(
                                'Commission ₹${_due!['commission_rs'] ?? '—'} • Settled ₹${_due!['settled_rs'] ?? '—'}'),
                          ),
                        ),
                      if (_week != null)
                        Card(
                          child: ListTile(
                            title: const Text('7-Day Earnings',
                                style: TextStyle(
                                    fontWeight: FontWeight.w800)),
                            trailing: Text(
                                '₹${_week!['earnings_rs'] ?? 0} / ${_week!['completed_count'] ?? 0} trips',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w800)),
                          ),
                        ),
                      if (_items.isEmpty)
                        const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text(
                                'Koi available trip nahi — nayi trip aate hi list khud refresh hogi (live). Pull-to-refresh bhi hai.')),
                      ..._items.map((b) {
                        final est = b.estimate;
                        return Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                                crossAxisAlignment:
                                    CrossAxisAlignment.start,
                                children: [
                                  Text(
                                      '${b.vehicleType} • ₹${b.priceRs?.toStringAsFixed(0) ?? '—'}',
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800)),
                                  Text(
                                      '${b.pickupAddress ?? ''} → ${b.dropAddress ?? ''}'),
                                  if (est != null)
                                    Text(
                                        'Earning ₹${est['earning_rs'] ?? '—'} (comm ₹${est['commission_rs'] ?? '—'})',
                                        style: const TextStyle(
                                            fontSize: 12,
                                            color: Colors.grey)),
                                  Row(children: [
                                    ElevatedButton(
                                        onPressed: _busy
                                            ? null
                                            : () => _accept(b),
                                        child: const Text('Accept')),
                                    const SizedBox(width: 8),
                                    OutlinedButton(
                                        onPressed: _busy
                                            ? null
                                            : () => _decline(b),
                                        child: const Text('Decline')),
                                  ]),
                                ]),
                          ),
                        );
                      }),
                    ],
                  ),
      ),
    );
  }
}

// ---------------- Trips (active + history + GPS) ----------------

class _TripsTab extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const _TripsTab({required this.session, required this.settings});

  @override
  State<_TripsTab> createState() => _TripsTabState();
}

class _TripsTabState extends State<_TripsTab> {
  late final DriverApi _api = widget.session.driver;
  List<Booking> _items = [];
  int _total = 0;
  String? _error;
  bool _loading = true;
  bool _busy = false;
  bool _sharing = false;
  Timer? _gps;
  String? _gpsMsg;
  final _dispute = TextEditingController();

  Booking? get _active {
    for (final b in _items) {
      if (b.status == 'accepted' ||
          b.status == 'arrived' ||
          b.status == 'in_transit') {
        return b;
      }
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _gps?.cancel();
    _dispute.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final h = await _api.history(limit: 20);
      if (!mounted) return;
      setState(() {
        _items = h.items;
        _total = h.total;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _friendly(e);
        _loading = false;
      });
    }
  }

  String? _nextStatus(Booking b) {
    if (b.status == 'accepted') return 'arrived';
    if (b.status == 'arrived') return 'in_transit';
    if (b.status == 'in_transit') return 'delivered';
    return null;
  }

  String _nextLabel(String? s) {
    if (s == 'arrived') return 'Arrived';
    if (s == 'in_transit') return 'Start trip';
    if (s == 'delivered') return 'Delivered';
    return '—';
  }

  Future<void> _advance(Booking b) async {
    final nx = _nextStatus(b);
    if (nx == null) return;
    setState(() => _busy = true);
    try {
      final updated = await _api.advance(b.id, nx);
      if (!mounted) return;
      setState(() {
        _items =
            _items.map((e) => e.id == updated.id ? updated : e).toList();
        _busy = false;
      });
      if (nx == 'delivered') await _stopShare(silent: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Status: $nx')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  Future<bool> _ensurePerm() async {
    final enabled = await Geolocator.isLocationServiceEnabled();
    if (!enabled) {
      setState(() => _gpsMsg = 'Location service OFF hai — ON karo.');
      return false;
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) {
      setState(() => _gpsMsg = 'Location permission denied — settings me allow karo.');
      return false;
    }
    return true;
  }

  Future<void> _startShare(Booking b) async {
    if (!await _ensurePerm()) return;
    setState(() {
      _sharing = true;
      _gpsMsg = 'Sharing… (5s)';
    });
    _gps?.cancel();
    _gps = Timer.periodic(const Duration(seconds: 5), (_) async {
      try {
        final pos = await Geolocator.getCurrentPosition(
            locationSettings:
                const LocationSettings(accuracy: LocationAccuracy.high));
        await _api.postLocation(b.id,
            lat: pos.latitude,
            lng: pos.longitude,
            accuracyM: pos.accuracy,
            speedMps: pos.speed < 0 ? null : pos.speed,
            headingDeg: pos.heading < 0 ? null : pos.heading);
        if (!mounted) return;
        setState(() => _gpsMsg =
            'Shared ${pos.latitude.toStringAsFixed(5)}, ${pos.longitude.toStringAsFixed(5)} (±${pos.accuracy.toStringAsFixed(0)}m)');
      } catch (e) {
        if (!mounted) return;
        setState(() => _gpsMsg = _friendly(e));
      }
    });
  }

  Future<void> _stopShare({bool silent = false}) async {
    _gps?.cancel();
    _gps = null;
    if (!mounted) return;
    setState(() {
      _sharing = false;
      if (!silent) _gpsMsg = 'Stopped.';
    });
  }

  Future<void> _sendDispute(Booking b) async {
    final reason = _dispute.text.trim();
    if (reason.length < 3) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Wajah kam se kam 3 akshar.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final updated = await _api.dispute(b.id, reason);
      if (!mounted) return;
      setState(() {
        _items =
            _items.map((e) => e.id == updated.id ? updated : e).toList();
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Issue reported.')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = _active;
    return AppScaffold(
      settings: widget.settings,
      title: 'Trips',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
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
                    padding: const EdgeInsets.all(12),
                    children: [
                      if (active != null) ...[
                        const Text('My Active Trip',
                            style: TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 16)),
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                                crossAxisAlignment:
                                    CrossAxisAlignment.start,
                                children: [
                                  Text(
                                      '${active.vehicleType} • ${active.status}',
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800)),
                                  Text(
                                      '${active.pickupAddress ?? ''} → ${active.dropAddress ?? ''}'),
                                  Text(
                                      '₹${active.priceRs?.toStringAsFixed(0) ?? '—'} (${active.paymentMethod})'),
                                  const SizedBox(height: 8),
                                  Wrap(spacing: 8, children: [
                                    ElevatedButton(
                                        onPressed: _busy
                                            ? null
                                            : () =>
                                                _advance(active),
                                        child: Text(_nextLabel(
                                            _nextStatus(active)))),
                                    if (!_sharing)
                                      OutlinedButton(
                                          onPressed: () =>
                                              _startShare(active),
                                          child: const Text(
                                              'Share location')),
                                    if (_sharing)
                                      OutlinedButton(
                                          onPressed: () =>
                                              _stopShare(),
                                          child: const Text('Stop')),
                                  ]),
                                  if (_gpsMsg != null)
                                    Text(_gpsMsg!,
                                        style: const TextStyle(
                                            fontSize: 12,
                                            color: Colors.grey)),
                                  TextField(
                                      controller: _dispute,
                                      maxLength: 500,
                                      decoration:
                                          const InputDecoration(
                                              hintText:
                                                  'Report issue (min 3)',
                                              border:
                                                  OutlineInputBorder())),
                                  OutlinedButton(
                                      onPressed: _busy
                                          ? null
                                          : () =>
                                              _sendDispute(active),
                                      child:
                                          const Text('Report Issue')),
                                ]),
                          ),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Text('History (total $_total)',
                          style: const TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 16)),
                      ..._items.map((b) => Card(
                            child: ListTile(
                              title: Text(
                                  '${b.vehicleType} • ${b.status}',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700)),
                              subtitle: Text(
                                  '${b.pickupAddress ?? ''} → ${b.dropAddress ?? ''}\n₹${b.priceRs?.toStringAsFixed(0) ?? '—'}'),
                              isThreeLine: true,
                            ),
                          )),
                    ],
                  ),
      ),
    );
  }
}

// ---------------- Money ----------------

class _MoneyTab extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const _MoneyTab({required this.session, required this.settings});

  @override
  State<_MoneyTab> createState() => _MoneyTabState();
}

class _MoneyTabState extends State<_MoneyTab> {
  late final DriverApi _api = widget.session.driver;
  Map<String, dynamic>? _due;
  Map<String, dynamic>? _week;
  List<Map<String, dynamic>> _payments = [];
  List<Map<String, dynamic>> _settlements = [];
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final due = await _api.commissionDue();
      Map<String, dynamic>? week;
      try {
        week = await _api.weeklyEarnings();
      } catch (_) {}
      final ledger = await _api.ledger();
      if (!mounted) return;
      setState(() {
        _due = due;
        _week = week;
        _payments = ((ledger['payments'] ?? []) as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _settlements = ((ledger['settlements'] ?? []) as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _friendly(e);
        _loading = false;
      });
    }
  }

  Future<void> _confirmCash(Map<String, dynamic> p) async {
    setState(() => _busy = true);
    try {
      await _api.confirmCash('${p['id']}');
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Cash received confirmed.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Money',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
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
                    padding: const EdgeInsets.all(12),
                    children: [
                      if (_due != null)
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                                crossAxisAlignment:
                                    CrossAxisAlignment.start,
                                children: [
                                  const Text('Commission due',
                                      style: TextStyle(
                                          fontWeight:
                                              FontWeight.w800)),
                                  Text(
                                      'Outstanding ₹${_due!['outstanding_rs'] ?? '—'} / limit ₹${_due!['limit_rs'] ?? '—'}'),
                                  Text(
                                      'Commission ₹${_due!['commission_rs'] ?? '—'} • Settled ₹${_due!['settled_rs'] ?? '—'}'),
                                ]),
                          ),
                        ),
                      if (_week != null)
                        Card(
                          child: ListTile(
                            title: const Text('7-Day',
                                style: TextStyle(
                                    fontWeight: FontWeight.w800)),
                            trailing: Text(
                                '₹${_week!['earnings_rs'] ?? 0} / ${_week!['completed_count'] ?? 0}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w800)),
                          ),
                        ),
                      const Text('Payments (50)',
                          style: TextStyle(
                              fontWeight: FontWeight.w800)),
                      ..._payments.map((p) => Card(
                            child: ListTile(
                              title: Text(
                                  '₹${p['gross_rs'] ?? '—'} • ${p['payment_method'] ?? ''} • ${p['payment_status'] ?? ''}',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700)),
                              subtitle: Text(
                                  'Earning ₹${p['driver_earning_rs'] ?? '—'} • Comm ₹${p['platform_commission_rs'] ?? '—'} (${p['commission_pct'] ?? '—'}%)\nBooking ${p['booking_id'] ?? ''}'),
                              isThreeLine: true,
                              trailing: (p['payment_method'] ==
                                          'cash' &&
                                      p['payment_status'] ==
                                          'pending')
                                  ? TextButton(
                                      onPressed: _busy
                                          ? null
                                          : () =>
                                              _confirmCash(p),
                                      child: const Text(
                                          'Cash received'))
                                  : null,
                            ),
                          )),
                      const SizedBox(height: 8),
                      const Text('Settlements',
                          style: TextStyle(
                              fontWeight: FontWeight.w800)),
                      ..._settlements.map((s) => Card(
                            child: ListTile(
                              title: Text(
                                  '₹${s['amount_rs'] ?? '—'} • ${s['method'] ?? ''}'),
                              subtitle: Text(
                                  '${s['reference_no'] ?? ''} • ${s['settled_at'] ?? s['created_at'] ?? ''}'),
                            ),
                          )),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }
}

// ---------------- Account ----------------

class _DriverAccountTab extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const _DriverAccountTab(
      {required this.session, required this.settings});

  @override
  State<_DriverAccountTab> createState() => _DriverAccountTabState();
}

class _DriverAccountTabState extends State<_DriverAccountTab> {
  final _upi = TextEditingController();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _upi.text = widget.session.user?.upiId ?? '';
  }

  @override
  void dispose() {
    _upi.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final v = _upi.text.trim();
    if (v.isNotEmpty &&
        !RegExp(r'^[\w.\-]{2,256}@[a-zA-Z]{2,64}$')
            .hasMatch(v)) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('UPI ID format naam@bank jaisa ho.')));
      return;
    }
    setState(() => _busy = true);
    final err =
        await widget.session.saveUpi(v.isEmpty ? null : v);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(err == null
            ? 'UPI saved.'
            : 'Save fail ($err).')));
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.session.user;
    return AppScaffold(
      settings: widget.settings,
      title: 'Driver Account',
      actions: [
        IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => widget.session.logout()),
      ],
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const Icon(Icons.person, size: 40),
              title: Text(u?.name ?? '—',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800)),
              subtitle: Text(
                  '${u?.phone ?? '—'}\n${u?.vehicleType ?? ''} • ${u?.vehicleNumber ?? ''}'),
              isThreeLine: true,
              trailing: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                    color: (u?.isVerified ?? false
                            ? Colors.green
                            : Colors.orange)
                        .withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20)),
                child: Text(
                    u?.isVerified ?? false
                        ? 'Verified'
                        : 'Pending',
                    style: TextStyle(
                        color: u?.isVerified ?? false
                            ? Colors.green
                            : Colors.orange,
                        fontWeight: FontWeight.w800)),
              ),
            ),
          ),
          if (!(u?.isVerified ?? false))
            const Card(
              child: Padding(
                padding: EdgeInsets.all(14),
                child: Text(
                    'Application PENDING_REVIEW — admin verify karega, tab tak jobs nahi dikhengi.'),
              ),
            ),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('UPI ID',
                        style: TextStyle(
                            fontWeight: FontWeight.w800)),
                    TextField(
                        controller: _upi,
                        decoration: const InputDecoration(
                            hintText: 'naam@bank',
                            border: OutlineInputBorder())),
                    const SizedBox(height: 8),
                    ElevatedButton(
                        onPressed: _busy ? null : _save,
                        child: Text(
                            _busy ? 'Ruko…' : 'Save UPI ID')),
                  ]),
            ),
          ),
          ElevatedButton(
              onPressed: () => widget.session.logout(),
              child: const Text('Logout →')),
        ],
      ),
    );
  }
}
