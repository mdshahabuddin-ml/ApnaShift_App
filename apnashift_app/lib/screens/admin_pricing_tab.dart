import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';

/// Pricing — admin-pricing.html parity: vehicle rates load/save +
/// history + global commission get/set.
class AdminPricingTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminPricingTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminPricingTab> createState() => _AdminPricingTabState();
}

class _AdminPricingTabState extends State<AdminPricingTab> {
  String _vehicle = 'pickup';
  final _base = TextEditingController();
  final _km = TextEditingController();
  final _helper = TextEditingController();
  final _comm = TextEditingController();
  final _globalComm = TextEditingController();
  List<Map<String, dynamic>> _history = [];
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
    _base.dispose();
    _km.dispose();
    _helper.dispose();
    _comm.dispose();
    _globalComm.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = widget.session.admin;
      final rules = await api.pricingRules();
      Map<String, dynamic>? mine;
      for (final r in rules) {
        if ('${r['vehicle_type']}' == _vehicle) mine = r;
      }
      final hist = await api.pricingHistory(limit: 20);
      Map<String, dynamic> comm = {};
      try {
        comm = await api.commission();
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        if (mine != null) {
          _base.text = '${mine['base_rs'] ?? ''}';
          _km.text = '${mine['per_km_rs'] ?? ''}';
          _helper.text = '${mine['helper_rs'] ?? ''}';
          _comm.text = '${mine['commission_pct'] ?? ''}';
        }
        final pct = comm['pct'] ??
            (comm['commission'] is Map
                ? (comm['commission'] as Map)['pct']
                : null);
        if (pct != null) _globalComm.text = '$pct';
        _history = hist;
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

  double? _num(String v) =>
      v.trim().isEmpty ? null : double.tryParse(v.trim());

  Future<void> _save() async {
    final base = _num(_base.text);
    final km = _num(_km.text);
    final helper = _num(_helper.text);
    final comm = _num(_comm.text);
    if (base == null && km == null && helper == null && comm == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Change at least one rate.')));
      return;
    }
    if ((comm != null && (comm < 0 || comm > 100))) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Commission must be between 0 and 100.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.session.admin.updatePricing(
          vehicleType: _vehicle,
          baseRs: base,
          perKmRs: km,
          helperRs: helper,
          commissionPct: comm);
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Rate saved.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _saveGlobal() async {
    final pct = _num(_globalComm.text);
    if (pct == null || pct < 0 || pct > 100) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('pct must be a number between 0 and 100.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.session.admin.updateCommission(pct);
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Commission saved.')));
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
      title: 'Pricing',
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
                    padding: const EdgeInsets.all(16),
                    children: [
                      DropdownButtonFormField<String>(
                        initialValue: _vehicle,
                        decoration: const InputDecoration(
                            labelText: 'Vehicle',
                            border: OutlineInputBorder()),
                        items: const [
                          DropdownMenuItem(
                              value: 'pickup',
                              child: Text('pickup')),
                          DropdownMenuItem(
                              value: 'mini_truck',
                              child: Text('mini_truck')),
                          DropdownMenuItem(
                              value: 'mini_tractor',
                              child: Text('mini_tractor')),
                        ],
                        onChanged: (v) {
                          if (v == null) return;
                          setState(() => _vehicle = v);
                          _load();
                        },
                      ),
                      const SizedBox(height: 8),
                      _numField(_base, 'Base Rs (>=0)'),
                      _numField(_km, 'Per km Rs (>=0)'),
                      _numField(_helper, 'Helper Rs (>=0)'),
                      _numField(
                          _comm, 'Commission % (0-100)'),
                      const SizedBox(height: 8),
                      ElevatedButton(
                          onPressed: _busy ? null : _save,
                          child: Text(
                              _busy ? 'Please wait…' : 'Save rate →')),
                      const SizedBox(height: 16),
                      const Text('Global commission %',
                          style: TextStyle(
                              fontWeight: FontWeight.w800)),
                      _numField(
                          _globalComm, 'pct (0-100, future bookings)'),
                      OutlinedButton(
                          onPressed:
                              _busy ? null : _saveGlobal,
                          child: const Text('Set global →')),
                      const SizedBox(height: 16),
                      const Text('History (20)',
                          style: TextStyle(
                              fontWeight: FontWeight.w800)),
                      ..._history.map((h) => Card(
                            child: ListTile(
                              title: Text(
                                  '${h['vehicle_type'] ?? ''}',
                                  style: const TextStyle(
                                      fontWeight:
                                          FontWeight.w700)),
                              subtitle: Text(
                                  '${h['created_at'] ?? ''}'),
                            ),
                          )),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }

  Widget _numField(TextEditingController c, String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: TextField(
            controller: c,
            keyboardType:
                const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
                labelText: label,
                border: const OutlineInputBorder())),
      );
}
