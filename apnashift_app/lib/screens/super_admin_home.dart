import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/admin_api.dart';
import '../api/api_client.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';
import 'login_screen.dart';
import 'super_admin_announcements_tab.dart';
import 'super_admin_app_updates_tab.dart';

/// Super Admin console — super-admin.html parity (mobile tabs).
/// SELECT-only superadmin router + existing admin endpoints (passthrough).
/// Tabs: Overview (ops + recent bookings) | Customers (lookup + detail +
/// reset-pw; suspend has NO backend endpoint — documented gap, no fake
/// button) | Audit (action/entity filters + pages) | Finance (commission
/// report + ledger + adjustments + balances + settle) | Announcements
/// (CRUD + schedule + maintenance block + push report/retry/run) |
/// App updates (release CRUD + publish/archive + push report/retry/run).
/// Sab data server se; koi sample nahi.
class SuperAdminHome extends StatefulWidget {
  final ApiClient api;
  final String name;
  final AppSettings? settings;
  const SuperAdminHome(
      {super.key, required this.api, required this.name, this.settings});

  @override
  State<SuperAdminHome> createState() => _SuperAdminHomeState();
}

class _SuperAdminHomeState extends State<SuperAdminHome> {
  int _tab = 0;

  Future<void> _logout() async {
    const store = FlutterSecureStorage();
    await store.delete(key: 'apnashift_admin_token');
    widget.api.close();
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.settings;
    final titles = [
      'Super Admin • ${widget.name}',
      'Customers',
      'Audit',
      'Finance',
      'Announcements',
      'App updates',
    ];
    final pages = [
      _OverviewTab(api: widget.api),
      _CustomersTab(api: widget.api),
      _AuditTab(api: widget.api),
      _FinanceTab(api: widget.api),
      SuperAdminAnnouncementsTab(api: widget.api),
      SuperAdminAppUpdatesTab(api: widget.api),
    ];
    if (s != null) {
      return Scaffold(
        body: AppScaffold(
          settings: s,
          title: titles[_tab],
          actions: [
            IconButton(
                tooltip: 'Logout',
                icon: const Icon(Icons.logout),
                onPressed: _logout),
          ],
          body: IndexedStack(index: _tab, children: pages),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(
                icon: Icon(Icons.dashboard), label: 'Overview'),
            NavigationDestination(
                icon: Icon(Icons.people), label: 'Customers'),
            NavigationDestination(
                icon: Icon(Icons.security), label: 'Audit'),
            NavigationDestination(
                icon: Icon(Icons.account_balance), label: 'Finance'),
            NavigationDestination(
                icon: Icon(Icons.campaign), label: 'Announce'),
            NavigationDestination(
                icon: Icon(Icons.system_update), label: 'Updates'),
          ],
        ),
      );
    }
    // Fallback when launched without settings (legacy path).
    return Scaffold(
      appBar: AppBar(
        title: Text(titles[_tab]),
        backgroundColor: navy,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
              tooltip: 'Logout',
              icon: const Icon(Icons.logout),
              onPressed: _logout)
        ],
      ),
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.dashboard), label: 'Overview'),
          NavigationDestination(
              icon: Icon(Icons.people), label: 'Customers'),
          NavigationDestination(
              icon: Icon(Icons.security), label: 'Audit'),
          NavigationDestination(
              icon: Icon(Icons.account_balance), label: 'Finance'),
          NavigationDestination(
              icon: Icon(Icons.campaign), label: 'Announce'),
          NavigationDestination(
              icon: Icon(Icons.system_update), label: 'Updates'),
        ],
      ),
    );
  }
}

String _num(Map<String, dynamic>? m, String k) {
  final v = m?[k];
  if (v is num) {
    return v.toString().replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+(?!\d))'), (m) => '${m[1]},');
  }
  return '—';
}

Widget _card(String label, String value) => Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
          title: Text(label,
              style:
                  const TextStyle(fontSize: 13, color: Colors.black54)),
          trailing: Text(value,
              style: const TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w800))),
    );

// ---------------- Overview ----------------

class _OverviewTab extends StatefulWidget {
  final ApiClient api;
  const _OverviewTab({required this.api});

  @override
  State<_OverviewTab> createState() => _OverviewTabState();
}

class _OverviewTabState extends State<_OverviewTab> {
  late final AdminApi _admin = AdminApi(widget.api);
  Map<String, dynamic>? _ov;
  List<Map<String, dynamic>> _recent = [];
  String? _error;
  bool _loading = true;

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
      final ov = await _admin.overview();
      List<Map<String, dynamic>> recent = [];
      try {
        final r = await _admin.bookings(limit: 10);
        recent = r.items;
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _ov = ov;
        _recent = recent;
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

  @override
  Widget build(BuildContext context) {
    final b = (_ov?['bookings'] ?? {}) as Map<String, dynamic>;
    final d = (_ov?['drivers'] ?? {}) as Map<String, dynamic>;
    final f = (_ov?['finance'] ?? {}) as Map<String, dynamic>;
    final c = (_ov?['customers'] ?? {}) as Map<String, dynamic>;
    return RefreshIndicator(
      onRefresh: _load,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? ListView(children: [adminErrorCard(_error!)])
              : ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    const Text('Operations',
                        style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800)),
                    _card('Customers', _num(c, 'total')),
                    _card(
                        'Drivers (active / pending / inactive)',
                        '${_num(d, 'active')} / ${_num(d, 'pending')} / ${_num(d, 'inactive')}'),
                    _card('Bookings total', _num(b, 'total')),
                    _card(
                        'Pending / In-progress',
                        '${_num(b, 'pending')} / ${_num(b, 'in_progress')}'),
                    _card('Completed / Cancelled',
                        '${_num(b, 'completed')} / ${_num(b, 'cancelled')}'),
                    _card('Cancel rate',
                        '${b['cancellation_rate'] ?? '—'}%'),
                    _card('Today (total / completed)',
                        '${_num(b, 'today_total')} / ${_num(b, 'today_completed')}'),
                    _card('Revenue (fares)',
                        '₹${f['fare_rs'] ?? '—'}'),
                    _card('Commission',
                        '₹${f['commission_rs'] ?? '—'}'),
                    _card('Outstanding',
                        '₹${f['outstanding_rs'] ?? '—'}'),
                    const SizedBox(height: 12),
                    const Text('Recent bookings (10)',
                        style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800)),
                    ..._recent.map((x) => Card(
                          child: ListTile(
                            title: Text(
                                '${x['vehicle_type'] ?? ''} • ${x['status'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight:
                                        FontWeight.w700)),
                            subtitle: Text(
                                '${(x['pickup'] is Map ? (x['pickup'] as Map)['address'] : x['pickup_address']) ?? ''} → ${(x['drop'] is Map ? (x['drop'] as Map)['address'] : x['drop_address']) ?? ''}'),
                            trailing: Text(
                                '₹${x['price_rs'] ?? '—'}',
                                style: const TextStyle(
                                    fontWeight:
                                        FontWeight.w800)),
                          ),
                        )),
                    const SizedBox(height: 24),
                  ],
                ),
    );
  }
}

// ---------------- Customers ----------------

class _CustomersTab extends StatefulWidget {
  final ApiClient api;
  const _CustomersTab({required this.api});

  @override
  State<_CustomersTab> createState() => _CustomersTabState();
}

class _CustomersTabState extends State<_CustomersTab> {
  late final AdminApi _admin = AdminApi(widget.api);
  final _phone = TextEditingController();
  Map<String, dynamic>? _detail;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() {
      _busy = true;
      _error = null;
      _detail = null;
    });
    try {
      final found = await _admin
          .lookupAccount(_phone.text.trim());
      final users = ((found['users'] ?? []) as List)
          .whereType<Map>()
          .toList();
      if (users.isEmpty) {
        if (!mounted) return;
        setState(() {
          _error = 'Customer not found.';
          _busy = false;
        });
        return;
      }
      final id = '${users.first['id']}';
      final detail = await _admin.superadminCustomer(id);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = adminFriendly(e);
        _busy = false;
      });
    }
  }

  Future<void> _resetPw() async {
    final id = '${(_detail?['customer'] as Map?)?['id'] ?? ''}';
    if (id.isEmpty) return;
    final c = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reset customer password'),
        content: TextField(
            controller: c,
            obscureText: true,
            decoration: const InputDecoration(
                hintText: 'New password (8+)',
                border: OutlineInputBorder())),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Back')),
          ElevatedButton(
              onPressed: () => Navigator.pop(
                  ctx, c.text.length >= 8),
              child: const Text('Reset')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _admin.resetUserPassword(id, c.text);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Password reset.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final cu = _detail?['customer'] is Map
        ? Map<String, dynamic>.from(_detail!['customer'] as Map)
        : null;
    final bookings = ((_detail?['bookings'] ?? []) as List)
        .whereType<Map>()
        .toList();
    final life = _detail?['lifetime'] is Map
        ? Map<String, dynamic>.from(_detail!['lifetime'] as Map)
        : null;
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        const Text(
            'Customer search (phone → history)',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                    labelText: 'Customer phone',
                    border: OutlineInputBorder()),
                onSubmitted: (_) => _search()),
          ),
          const SizedBox(width: 8),
          ElevatedButton(
              onPressed: _busy ? null : _search,
              child: Text(_busy ? '…' : 'Find')),
        ]),
        const SizedBox(height: 4),
        const Text(
            'Note: there is no backend endpoint to suspend a customer (documented gap) — so there is no suspend button.',
            style: TextStyle(fontSize: 12, color: Colors.grey)),
        if (_error != null)
          Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_error!,
                  style: const TextStyle(color: Colors.red))),
        if (cu != null) ...[
          Card(
            child: ListTile(
              leading: const Icon(Icons.person, size: 40),
              title: Text('${cu['name'] ?? ''}',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800)),
              subtitle: Text(
                  '${cu['phone'] ?? ''}\nTrips ${life?['delivered_trips'] ?? '—'} • Spent ₹${life?['spent_rs'] ?? '—'}'),
              isThreeLine: true,
              trailing: TextButton(
                  onPressed: _resetPw,
                  child: const Text('Reset PW')),
            ),
          ),
          ...bookings.map((b) => Card(
                child: ListTile(
                  title: Text(
                      '${b['vehicle_type'] ?? ''} • ${b['status'] ?? ''}',
                      style: const TextStyle(
                          fontWeight: FontWeight.w700)),
                  trailing: Text('₹${b['price_rs'] ?? '—'}',
                      style: const TextStyle(
                          fontWeight: FontWeight.w800)),
                ),
              )),
        ],
        const SizedBox(height: 24),
      ],
    );
  }
}

// ---------------- Audit ----------------

class _AuditTab extends StatefulWidget {
  final ApiClient api;
  const _AuditTab({required this.api});

  @override
  State<_AuditTab> createState() => _AuditTabState();
}

class _AuditTabState extends State<_AuditTab> {
  late final AdminApi _admin = AdminApi(widget.api);
  List<Map<String, dynamic>> _logs = [];
  int _total = 0;
  int _page = 1;
  String _action = '';
  String _entity = '';
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
    });
    try {
      final logs = await _admin.auditLogs(
          limit: 20,
          action: _action.isEmpty ? null : _action,
          entity: _entity.isEmpty ? null : _entity);
      final total = await _admin.auditLogsTotal(
          action: _action.isEmpty ? null : _action,
          entity: _entity.isEmpty ? null : _entity);
      if (!mounted) return;
      setState(() {
        _logs = logs;
        _total = total;
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
      final logs = await _admin.auditLogs(
          limit: 20,
          page: _page + 1,
          action: _action.isEmpty ? null : _action,
          entity: _entity.isEmpty ? null : _entity);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _logs = [..._logs, ...logs];
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasMore = _logs.length < _total;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          Expanded(
            child: TextField(
                decoration: const InputDecoration(
                    labelText: 'action (e.g. booking.created)',
                    border: OutlineInputBorder()),
                onChanged: (v) => _action = v.trim()),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
                decoration: const InputDecoration(
                    labelText: 'entity (e.g. booking)',
                    border: OutlineInputBorder()),
                onChanged: (v) => _entity = v.trim()),
          ),
          const SizedBox(width: 8),
          ElevatedButton(
              onPressed: _load, child: const Text('Go')),
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
                      itemCount: _logs.length + 1,
                      itemBuilder: (c, i) {
                        if (i == _logs.length) {
                          return Padding(
                            padding: const EdgeInsets.all(12),
                            child: hasMore
                                ? OutlinedButton(
                                    onPressed: _more,
                                    child:
                                        const Text('Show more'))
                                : Text(
                                    'Total $_total • showing ${_logs.length}',
                                    style: const TextStyle(
                                        fontSize: 12,
                                        color: Colors.grey)),
                          );
                        }
                        final l = _logs[i];
                        return Card(
                          margin: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 4),
                          child: ListTile(
                            title: Text('${l['action'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 14)),
                            subtitle: Text(
                                '${l['entity'] ?? ''} • ${l['admin_name'] ?? ''}'),
                            trailing: Text(
                                '${l['created_at'] ?? ''}'
                                    .toString()
                                    .split('T')
                                    .first,
                                style: const TextStyle(
                                    fontSize: 12)),
                          ),
                        );
                      },
                    ),
        ),
      ),
    ]);
  }
}

// ---------------- Finance ----------------

class _FinanceTab extends StatefulWidget {
  final ApiClient api;
  const _FinanceTab({required this.api});

  @override
  State<_FinanceTab> createState() => _FinanceTabState();
}

class _FinanceTabState extends State<_FinanceTab> {
  late final AdminApi _admin = AdminApi(widget.api);
  Map<String, dynamic>? _report;
  String _group = 'day';
  List<Map<String, dynamic>> _balances = [];
  final _driverId = TextEditingController();
  List<Map<String, dynamic>> _ledger = [];
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _driverId.dispose();
    super.dispose();
  }

  String _weekAgo() => DateTime.now()
      .subtract(const Duration(days: 7))
      .toIso8601String()
      .split('T')
      .first;
  String _today() =>
      DateTime.now().toIso8601String().split('T').first;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final report = await _admin.reportsSummary(
          from: _weekAgo(), to: _today(), groupBy: _group);
      final bals = await _admin.driverBalances(limit: 50);
      if (!mounted) return;
      setState(() {
        _report = report;
        _balances = bals;
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

  Future<void> _loadLedger() async {
    final id = _driverId.text.trim();
    if (id.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Enter the driver UUID.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final l = await _admin.ledger(driverId: id);
      if (!mounted) return;
      final pays = ((l['payments'] ?? l['ledger'] ?? []) as List)
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      setState(() {
        _ledger = pays;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _adjust(Map<String, dynamic> p) async {
    final commC = TextEditingController(text: '0');
    final earnC = TextEditingController(text: '0');
    final reasonC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Adjustment (paise, append-only)'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
              controller: commC,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: 'commission_delta_paise (int)',
                  border: OutlineInputBorder())),
          const SizedBox(height: 8),
          TextField(
              controller: earnC,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: 'earning_delta_paise (int)',
                  border: OutlineInputBorder())),
          const SizedBox(height: 8),
          TextField(
              controller: reasonC,
              maxLength: 500,
              decoration: const InputDecoration(
                  labelText: 'reason (min 3)',
                  border: OutlineInputBorder())),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Back')),
          ElevatedButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (ok != true) return;
    final cd = int.tryParse(commC.text.trim()) ?? 0;
    final ed = int.tryParse(earnC.text.trim()) ?? 0;
    if (cd == 0 && ed == 0) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('At least one delta must be non-zero.')));
      return;
    }
    if (reasonC.text.trim().length < 3) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Reason must be at least 3 characters.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await _admin.createAdjustment(
          paymentId: '${p['id']}',
          commissionDeltaPaise: cd,
          earningDeltaPaise: ed,
          reason: reasonC.text.trim());
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Adjustment saved.')));
      await _loadLedger();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? ListView(children: [adminErrorCard(_error!)])
              : ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    Row(children: [
                      const Text('Commission report: ',
                          style: TextStyle(
                              fontWeight: FontWeight.w800)),
                      DropdownButton<String>(
                        value: _group,
                        items: const [
                          DropdownMenuItem(
                              value: 'day',
                              child: Text('day')),
                          DropdownMenuItem(
                              value: 'week',
                              child: Text('week')),
                          DropdownMenuItem(
                              value: 'month',
                              child: Text('month')),
                        ],
                        onChanged: (v) {
                          if (v == null) return;
                          setState(() => _group = v);
                          _load();
                        },
                      ),
                    ]),
                    if (_report != null)
                      _card(
                          'Trips / Comm / Settled / Pending',
                          '${_report!['delivered_trips'] ?? '—'} / ₹${_report!['commission_rs'] ?? '—'} / ₹${_report!['settled_rs'] ?? '—'} / ₹${_report!['pending_rs'] ?? '—'}'),
                    const SizedBox(height: 8),
                    const Text('Driver balances (50)',
                        style: TextStyle(
                            fontWeight: FontWeight.w800,
                            fontSize: 16)),
                    ..._balances.take(10).map((r) => Card(
                          child: ListTile(
                            title: Text(
                                '${r['name'] ?? r['driver_id'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight:
                                        FontWeight.w700)),
                            trailing: Text(
                                'Due ₹${r['outstanding_rs'] ?? '—'}',
                                style: const TextStyle(
                                    fontWeight:
                                        FontWeight.w800)),
                          ),
                        )),
                    const SizedBox(height: 8),
                    const Text('Payment ledger (driver UUID)',
                        style: TextStyle(
                            fontWeight: FontWeight.w800,
                            fontSize: 16)),
                    Row(children: [
                      Expanded(
                        child: TextField(
                            controller: _driverId,
                            decoration: const InputDecoration(
                                labelText: 'driver_id (UUID)',
                                border: OutlineInputBorder())),
                      ),
                      const SizedBox(width: 8),
                      ElevatedButton(
                          onPressed:
                              _busy ? null : _loadLedger,
                          child: const Text('Load')),
                    ]),
                    ..._ledger.map((p) => Card(
                          child: ListTile(
                            title: Text(
                                '₹${p['gross_rs'] ?? '—'} • ${p['payment_status'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight:
                                        FontWeight.w700)),
                            subtitle: Text(
                                'Earn ₹${p['driver_earning_rs'] ?? '—'} • Comm ₹${p['platform_commission_rs'] ?? '—'}\n${p['booking_id'] ?? ''}'),
                            isThreeLine: true,
                            trailing: TextButton(
                                onPressed: _busy
                                    ? null
                                    : () => _adjust(p),
                                child:
                                    const Text('Adjust')),
                          ),
                        )),
                    const SizedBox(height: 24),
                  ],
                ),
    );
  }
}
