import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';

/// Bookings — admin-bookings.html parity: status/disputed/from/to filters,
/// pagination, per-card verified-driver dropdown + Assign.
class AdminBookingsTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminBookingsTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminBookingsTab> createState() => _AdminBookingsTabState();
}

const _statuses = [
  '',
  'pending',
  'accepted',
  'arrived',
  'in_transit',
  'delivered',
  'cancelled'
];

class _AdminBookingsTabState extends State<AdminBookingsTab> {
  String _status = '';
  bool? _disputed;
  DateTime? _from;
  DateTime? _to;
  List<Map<String, dynamic>> _items = [];
  int _total = 0;
  int _page = 1;
  List<Map<String, dynamic>> _drivers = [];
  final Map<String, String?> _picked = {};
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String? _iso(DateTime? d, {bool end = false}) {
    if (d == null) return null;
    if (end) {
      return DateTime(d.year, d.month, d.day, 23, 59, 59)
          .toUtc()
          .toIso8601String();
    }
    return DateTime(d.year, d.month, d.day).toUtc().toIso8601String();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
    });
    try {
      final api = widget.session.admin;
      final r = await api.bookings(
          status: _status.isEmpty ? null : _status,
          disputed: _disputed,
          from: _iso(_from),
          to: _iso(_to, end: true),
          page: 1,
          limit: 20);
      List<Map<String, dynamic>> drivers = [];
      try {
        final d =
            await api.drivers(status: 'verified', limit: 100);
        drivers = d.items;
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _total = r.total;
        _drivers = drivers;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = adminFriendly(e);
        _loading = false;
      });
    }
  }

  Future<void> _more() async {
    try {
      final r = await widget.session.admin.bookings(
          status: _status.isEmpty ? null : _status,
          disputed: _disputed,
          from: _iso(_from),
          to: _iso(_to, end: true),
          page: _page + 1,
          limit: 20);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _items = [..._items, ...r.items];
        _total = r.total;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _assign(Map<String, dynamic> b) async {
    final drv = _picked['${b['id']}'];
    if (drv == null || drv.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Pehle driver chuno.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.session.admin
          .assignBooking('${b['id']}', drv);
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Driver assigned.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasMore = _items.length < _total;
    return AppScaffold(
      settings: widget.settings,
      title: 'Bookings ($_total)',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
      ],
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Column(children: [
            Row(children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _status,
                  decoration: const InputDecoration(
                      labelText: 'Status',
                      border: OutlineInputBorder()),
                  items: _statuses
                      .map((s) => DropdownMenuItem(
                          value: s,
                          child: Text(s.isEmpty ? 'All' : s)))
                      .toList(),
                  onChanged: (v) =>
                      setState(() => _status = v ?? ''),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: DropdownButtonFormField<bool?>(
                  initialValue: _disputed,
                  decoration: const InputDecoration(
                      labelText: 'Disputed',
                      border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(
                        value: null, child: Text('All')),
                    DropdownMenuItem(
                        value: true, child: Text('Disputed')),
                    DropdownMenuItem(
                        value: false,
                        child: Text('Not disputed')),
                  ],
                  onChanged: (v) =>
                      setState(() => _disputed = v),
                ),
              ),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                  child: OutlinedButton(
                      onPressed: () async {
                        final d = await showDatePicker(
                            context: context,
                            firstDate: DateTime(2024),
                            lastDate: DateTime.now());
                        if (d != null) {
                          setState(() => _from = d);
                        }
                      },
                      child: Text(_from == null
                          ? 'From'
                          : '${_from!.day}/${_from!.month}/${_from!.year}'))),
              const SizedBox(width: 8),
              Expanded(
                  child: OutlinedButton(
                      onPressed: () async {
                        final d = await showDatePicker(
                            context: context,
                            firstDate: DateTime(2024),
                            lastDate: DateTime.now());
                        if (d != null) {
                          setState(() => _to = d);
                        }
                      },
                      child: Text(_to == null
                          ? 'To'
                          : '${_to!.day}/${_to!.month}/${_to!.year}'))),
              const SizedBox(width: 8),
              ElevatedButton(
                  onPressed: _load,
                  child: const Text('Load')),
            ]),
          ]),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? ListView(children: [adminErrorCard(_error!)])
                    : ListView.builder(
                        itemCount: _items.length + 1,
                        itemBuilder: (c, i) {
                          if (i == _items.length) {
                            return Padding(
                              padding: const EdgeInsets.all(12),
                              child: hasMore
                                  ? OutlinedButton(
                                      onPressed: _more,
                                      child:
                                          const Text('Show more'))
                                  : Text(
                                      'Total $_total • showing ${_items.length}',
                                      style: const TextStyle(
                                          fontSize: 12,
                                          color: Colors.grey)),
                            );
                          }
                          final b = _items[i];
                          final disputed =
                              b['disputed'] == true;
                          final pickup = b['pickup'] is Map
                              ? (b['pickup'] as Map)['address']
                              : b['pickup_address'];
                          final drop = b['drop'] is Map
                              ? (b['drop'] as Map)['address']
                              : b['drop_address'];
                          return Card(
                            color: disputed
                                ? Colors.red.shade50
                                : null,
                            margin: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 6),
                            child: Padding(
                              padding:
                                  const EdgeInsets.all(12),
                              child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment
                                          .start,
                                  children: [
                                    Row(children: [
                                      Expanded(
                                          child: Text(
                                              '${b['vehicle_type'] ?? ''} • ₹${b['price_rs'] ?? '—'}',
                                              style: const TextStyle(
                                                  fontWeight:
                                                      FontWeight
                                                          .w800))),
                                      adminPill(
                                          '${b['status'] ?? ''}'),
                                    ]),
                                    Text('$pickup → $drop',
                                        style: const TextStyle(
                                            fontSize: 13)),
                                    if (disputed)
                                      Text(
                                          'Disputed: ${b['dispute_reason'] ?? ''}',
                                          style: const TextStyle(
                                              color: Colors.red,
                                              fontSize: 12)),
                                    if ('${b['status']}' ==
                                        'pending') ...[
                                      DropdownButtonFormField<
                                          String>(
                                        initialValue: _picked[
                                            '${b['id']}'],
                                        decoration:
                                            const InputDecoration(
                                                labelText:
                                                    'Driver (verified 100)',
                                                border:
                                                    OutlineInputBorder()),
                                        items: _drivers
                                            .map((d) =>
                                                DropdownMenuItem(
                                                    value:
                                                        '${d['id']}',
                                                    child: Text(
                                                        '${d['name']} • ${d['vehicle_number']}',
                                                        overflow:
                                                            TextOverflow
                                                                .ellipsis)))
                                            .toList(),
                                        onChanged: (v) =>
                                            setState(() =>
                                                _picked['${b['id']}'] =
                                                    v),
                                      ),
                                      const SizedBox(height: 8),
                                      ElevatedButton(
                                          onPressed: _busy
                                              ? null
                                              : () =>
                                                  _assign(b),
                                          child: const Text(
                                              'Assign Driver')),
                                    ],
                                  ]),
                            ),
                          );
                        },
                      ),
          ),
        ),
      ]),
    );
  }
}
