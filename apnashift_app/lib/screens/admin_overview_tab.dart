import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';

/// Overview — admin-home.html stat tiles + admin-dashboard Overview parity:
/// pending verifications, today's bookings, commission due, disputed.
class AdminOverviewTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminOverviewTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminOverviewTab> createState() => _AdminOverviewTabState();
}

class _AdminOverviewTabState extends State<AdminOverviewTab> {
  Map<String, dynamic>? _stats;
  int _pendingDrivers = 0;
  int _disputed = 0;
  double? _outstanding;
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
      final api = widget.session.admin;
      final stats = await api.stats();
      int pending = 0;
      int disputed = 0;
      double? outstanding;
      try {
        final d = await api.drivers(status: 'pending', limit: 1);
        pending = d.total;
      } catch (_) {}
      try {
        final b =
            await api.bookings(disputed: true, limit: 1);
        disputed = b.total;
      } catch (_) {}
      try {
        final bals = await api.driverBalances(limit: 50);
        double sum = 0;
        for (final r in bals) {
          sum += double.tryParse('${r['outstanding_rs'] ?? 0}') ?? 0;
        }
        outstanding = sum;
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _stats = stats;
        _pendingDrivers = pending;
        _disputed = disputed;
        _outstanding = outstanding;
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

  Widget _tile(String label, String value) => Card(
        child: ListTile(
          title: Text(label,
              style:
                  const TextStyle(fontSize: 13, color: Colors.black54)),
          trailing: Text(value,
              style: const TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w800)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Admin Overview',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
        IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => widget.session.logout()),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [adminErrorCard(_error!)])
                : ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      _tile('Pending verifications',
                          '$_pendingDrivers'),
                      _tile('Disputed bookings', '$_disputed'),
                      _tile(
                          'Commission outstanding (top 50)',
                          _outstanding == null
                              ? '—'
                              : '₹${_outstanding!.toStringAsFixed(0)}'),
                      const SizedBox(height: 8),
                      const Text('Today / Week / Total',
                          style: TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      _tile('Bookings today',
                          '${(_stats?['today'] is Map ? (_stats!['today'] as Map)['bookings'] : null) ?? (_stats?['today_bookings'] ?? '—')}'),
                      _tile('Revenue total (₹)',
                          '${(_stats?['total'] is Map ? (_stats!['total'] as Map)['revenue_rs'] : null) ?? (_stats?['revenue_rs'] ?? '—')}'),
                      _tile('Completed total',
                          '${(_stats?['total'] is Map ? (_stats!['total'] as Map)['completed'] : null) ?? '—'}'),
                      _tile('Cancelled total',
                          '${(_stats?['total'] is Map ? (_stats!['total'] as Map)['cancelled'] : null) ?? '—'}'),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }
}
