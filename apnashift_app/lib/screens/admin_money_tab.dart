import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';

/// Money — payment-status.html + admin-dashboard Settlement parity:
/// outstanding, driver dues + record payment, weekly periods
/// (generate/pay/dispute/resolve), reports summary.
class AdminMoneyTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminMoneyTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminMoneyTab> createState() => _AdminMoneyTabState();
}

class _AdminMoneyTabState extends State<AdminMoneyTab> {
  List<Map<String, dynamic>> _balances = [];
  List<Map<String, dynamic>> _periods = [];
  Map<String, dynamic>? _report;
  String _group = 'day';
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
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
      final api = widget.session.admin;
      final bals = await api.driverBalances(limit: 100);
      List<Map<String, dynamic>> periods = [];
      try {
        periods = await api.settlementPeriods(limit: 15);
      } catch (_) {}
      Map<String, dynamic>? report;
      try {
        report = await api.reportsSummary(
            from: _weekAgo(), to: _today(), groupBy: _group);
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _balances = bals;
        _periods = periods;
        _report = report;
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

  double _outstandingTotal() {
    double sum = 0;
    for (final r in _balances) {
      sum += double.tryParse('${r['outstanding_rs'] ?? 0}') ?? 0;
    }
    return sum;
  }

  Future<void> _settle(Map<String, dynamic> row) async {
    final amtC = TextEditingController(
        text: '${row['outstanding_rs'] ?? ''}');
    String method = 'cash';
    final refC = TextEditingController();
    final notesC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Settle — ${row['name'] ?? row['driver_id'] ?? ''}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
              controller: amtC,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                  labelText: 'amount_rs (>0)',
                  border: OutlineInputBorder())),
          DropdownButtonFormField<String>(
            initialValue: method,
            items: const [
              DropdownMenuItem(
                  value: 'cash', child: Text('cash')),
              DropdownMenuItem(
                  value: 'bank_transfer',
                  child: Text('bank_transfer')),
              DropdownMenuItem(value: 'upi', child: Text('upi')),
            ],
            onChanged: (v) => method = v ?? 'cash',
          ),
          TextField(
              controller: refC,
              decoration: const InputDecoration(
                  labelText: 'reference_no (bank/upi required)',
                  border: OutlineInputBorder())),
          TextField(
              controller: notesC,
              decoration: const InputDecoration(
                  labelText: 'notes (optional)',
                  border: OutlineInputBorder())),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Back')),
          ElevatedButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Settle')),
        ],
      ),
    );
    if (ok != true) return;
    final amt = double.tryParse(amtC.text.trim());
    if (amt == null || amt <= 0) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Amount must be more than 0.')));
      return;
    }
    if (method != 'cash' && refC.text.trim().length < 2) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('reference_no is required for bank/upi.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.session.admin.createSettlement(
          driverId: '${row['driver_id'] ?? row['id']}',
          amountRs: amt,
          method: method,
          referenceNo:
              refC.text.trim().isEmpty ? null : refC.text.trim(),
          notes: notesC.text.trim().isEmpty
              ? null
              : notesC.text.trim());
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Settlement recorded.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _generateWeek() async {
    setState(() => _busy = true);
    try {
      await widget.session.admin.generatePeriod();
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Week generated.')));
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
                ? ListView(children: [adminErrorCard(_error!)])
                : ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      Card(
                        child: ListTile(
                          title: const Text(
                              'Total outstanding',
                              style: TextStyle(
                                  fontWeight: FontWeight.w800)),
                          trailing: Text(
                              '₹${_outstandingTotal().toStringAsFixed(0)}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w800,
                                  fontSize: 18)),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(children: [
                        const Text('Reports: ',
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
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Text(
                                'Trips ${_report!['delivered_trips'] ?? '—'} • Comm ₹${_report!['commission_rs'] ?? '—'} • Settled ₹${_report!['settled_rs'] ?? '—'} • Pending ₹${_report!['pending_rs'] ?? '—'}',
                                style: const TextStyle(
                                    fontSize: 13)),
                          ),
                        ),
                      const SizedBox(height: 8),
                      const Text('Driver dues',
                          style: TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      ..._balances.take(20).map((r) => Card(
                            child: ListTile(
                              title: Text(
                                  '${r['name'] ?? r['driver_id'] ?? ''}',
                                  style: const TextStyle(
                                      fontWeight:
                                          FontWeight.w700)),
                              subtitle: Text(
                                  'Due ₹${r['outstanding_rs'] ?? '—'} • Comm ₹${r['commission_rs'] ?? '—'}'),
                              trailing: TextButton(
                                  onPressed: _busy
                                      ? null
                                      : () => _settle(r),
                                  child:
                                      const Text('Settle')),
                            ),
                          )),
                      const SizedBox(height: 8),
                      Row(children: [
                        const Text('Settlement weeks',
                            style: TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 16)),
                        const Spacer(),
                        OutlinedButton(
                            onPressed:
                                _busy ? null : _generateWeek,
                            child:
                                const Text('Generate week')),
                      ]),
                      ..._periods.map((p) => Card(
                            child: ListTile(
                              title: Text(
                                  '${p['week_start'] ?? ''} → ${p['week_end'] ?? ''}',
                                  style: const TextStyle(
                                      fontWeight:
                                          FontWeight.w700)),
                              subtitle: Text(
                                  '${p['status'] ?? ''} • Comm ₹${p['commission_paise'] != null ? (int.tryParse('${p['commission_paise']}') ?? 0) / 100 : (p['commission_rs'] ?? '—')}'),
                              trailing: adminPill(
                                  '${p['status'] ?? ''}'),
                              onTap: () =>
                                  _periodActions(p),
                            ),
                          )),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }

  void _periodActions(Map<String, dynamic> p) {
    final id = '${p['id']}';
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Week ${p['week_start'] ?? ''}'),
        content: Text('Status: ${p['status'] ?? ''}'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Close')),
          TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                _disputeResolve(id, true);
              },
              child: const Text('Dispute')),
          TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                _disputeResolve(id, false);
              },
              child: const Text('Resolve')),
        ],
      ),
    );
  }

  Future<void> _disputeResolve(String id, bool dispute) async {
    try {
      if (dispute) {
        await widget.session.admin.disputePeriod(id);
      } else {
        await widget.session.admin.resolvePeriod(id);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(dispute ? 'Disputed.' : 'Resolved.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }
}
