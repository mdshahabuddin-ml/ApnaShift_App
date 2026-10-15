import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api/api_client.dart';
import '../api/enterprise_api.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';

/// Enterprise pitch + inquiry — enterprise.html parity (mobile).
/// Wizard fields + same validations; success card + WhatsApp handoff
/// (wa.me/918757160137, popup fallback — website parity, no auto-send).
class EnterpriseScreen extends StatefulWidget {
  final AppSettings settings;
  final ApiClient? api;
  const EnterpriseScreen({super.key, required this.settings, this.api});

  @override
  State<EnterpriseScreen> createState() => _EnterpriseScreenState();
}

class _EnterpriseScreenState extends State<EnterpriseScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _phone = TextEditingController();
  final _company = TextEditingController();
  final _website = TextEditingController();
  final _designation = TextEditingController();
  String? _businessType;
  String? _companySize;
  final _cities = TextEditingController();
  final _state = TextEditingController();
  final _locCount = TextEditingController();
  final Set<String> _services = {};
  final Set<String> _vehicles = {};
  String? _fleet;
  String? _trips;
  DateTime? _start;
  String? _freq;
  String? _budget;
  final _req = TextEditingController();
  bool _consent = false;
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _done;

  late final EnterpriseApi _api =
      EnterpriseApi(widget.api ?? ApiClient());

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _phone.dispose();
    _company.dispose();
    _website.dispose();
    _designation.dispose();
    _cities.dispose();
    _state.dispose();
    _locCount.dispose();
    _req.dispose();
    super.dispose();
  }

  Map<String, dynamic> _fields() => {
        'full_name': _name.text.trim(),
        'email': _email.text.trim().toLowerCase(),
        'phone': normalizeEnterprisePhone(_phone.text),
        'company_name': _company.text.trim(),
        if (_website.text.trim().isNotEmpty)
          'website': _website.text.trim(),
        if (_designation.text.trim().isNotEmpty)
          'designation': _designation.text.trim(),
        if (_businessType != null) 'business_type': _businessType,
        if (_companySize != null) 'company_size': _companySize,
        if (_cities.text.trim().isNotEmpty)
          'cities': _cities.text.trim(),
        if (_state.text.trim().isNotEmpty)
          'operating_state': _state.text.trim(),
        if (_locCount.text.trim().isNotEmpty)
          'locations_count': int.tryParse(_locCount.text.trim()),
        'services_required': _services.toList(),
        'vehicle_types': _vehicles.toList(),
        if (_fleet != null) 'fleet_size': _fleet,
        if (_trips != null) 'monthly_trips': _trips,
        if (_start != null)
          'start_date':
              '${_start!.year.toString().padLeft(4, '0')}-${_start!.month.toString().padLeft(2, '0')}-${_start!.day.toString().padLeft(2, '0')}',
        if (_freq != null) 'service_frequency': _freq,
        if (_budget != null) 'budget_range': _budget,
        if (_req.text.trim().isNotEmpty)
          'requirements': _req.text.trim(),
        'consent': _consent,
      };

  Future<void> _submit() async {
    final v = validateEnterprise({..._fields(), 'consent': _consent});
    if (v != null) {
      setState(() => _error = v);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await _api.submit(_fields());
      if (!mounted) return;
      setState(() {
        _busy = false;
        _done = r;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is ApiException
            ? (e.code == 'duplicate_inquiry'
                ? 'Ye email+company pichle 30 din me bhej chuke ho.'
                : e.code == 'validation_failed'
                    ? 'Details check karo.'
                    : 'Submit fail (${e.code}).')
            : 'Server se baat nahi ho payi.';
      });
    }
  }

  Future<void> _whatsapp() async {
    final summary =
        'ApnaShift Enterprise inquiry%0AName: ${_name.text.trim()}%0ACompany: ${_company.text.trim()}%0APhone: ${_phone.text.trim()}';
    final uri = Uri.parse(
        'https://wa.me/918757160137?text=$summary');
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('WhatsApp nahi khula — 918757160137 par likho.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_done != null) {
      return AppScaffold(
        settings: widget.settings,
        title: 'Enterprise',
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.check_circle,
                    size: 64, color: Colors.green),
                const SizedBox(height: 12),
                Text('Inquiry ${_done!['id'] ?? ''} received',
                    style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 18)),
                Text('Status: ${_done!['status'] ?? 'NEW'}'),
                const SizedBox(height: 16),
                ElevatedButton(
                    onPressed: _whatsapp,
                    child: const Text(
                        'WhatsApp par baat karo →')),
                const SizedBox(height: 8),
                const Text(
                    'Handoff only — auto-send nahi hota (website parity).',
                    style:
                        TextStyle(fontSize: 12, color: Colors.grey)),
              ]),
        ),
      );
    }
    return AppScaffold(
      settings: widget.settings,
      title: 'Enterprise',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('B2B Shifting for Business',
              style:
                  TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
          const Text(
              'Fleet • Monthly trips • Scheduled & on-demand',
              style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 12),
          if (_error != null)
            Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(_error!,
                    style: const TextStyle(color: Colors.red))),
          if (_error != null) const SizedBox(height: 8),
          _tf(_name, 'Full name *'),
          _tf(_email, 'Work email *',
              kb: TextInputType.emailAddress),
          _tf(_phone, 'Phone *', kb: TextInputType.phone),
          _tf(_company, 'Company name *'),
          _tf(_website, 'Website (optional)'),
          _tf(_designation, 'Designation (optional)'),
          _drop('Business type', _businessType,
              enterpriseBusinessTypes, (v) {
            setState(() => _businessType = v);
          }),
          _drop('Company size', _companySize,
              enterpriseCompanySizes, (v) {
            setState(() => _companySize = v);
          }),
          _tf(_cities, 'Cities (optional)'),
          _tf(_state, 'Operating state (optional)'),
          _tf(_locCount, 'Locations count (1-100000)',
              kb: TextInputType.number),
          const SizedBox(height: 8),
          const Text('Services required',
              style: TextStyle(fontWeight: FontWeight.w700)),
          Wrap(
            spacing: 6,
            children: enterpriseServices
                .map((s) => FilterChip(
                    label: Text(s, style: const TextStyle(fontSize: 12)),
                    selected: _services.contains(s),
                    onSelected: (_) => setState(() {
                          if (_services.contains(s)) {
                            _services.remove(s);
                          } else {
                            _services.add(s);
                          }
                        })))
                .toList(),
          ),
          const SizedBox(height: 8),
          const Text('Vehicle types',
              style: TextStyle(fontWeight: FontWeight.w700)),
          Wrap(
            spacing: 6,
            children: enterpriseVehicles
                .map((s) => FilterChip(
                    label: Text(s, style: const TextStyle(fontSize: 12)),
                    selected: _vehicles.contains(s),
                    onSelected: (_) => setState(() {
                          if (_vehicles.contains(s)) {
                            _vehicles.remove(s);
                          } else {
                            _vehicles.add(s);
                          }
                        })))
                .toList(),
          ),
          _drop('Fleet size', _fleet, enterpriseFleetSizes,
              (v) {
            setState(() => _fleet = v);
          }),
          _drop('Monthly trips', _trips, enterpriseMonthlyTrips,
              (v) {
            setState(() => _trips = v);
          }),
          Row(children: [
            Expanded(
                child: Text(_start == null
                    ? 'Start date: optional'
                    : 'Start: ${_start!.day}/${_start!.month}/${_start!.year}')),
            TextButton(
                onPressed: () async {
                  final d = await showDatePicker(
                      context: context,
                      firstDate: DateTime(2020),
                      lastDate: DateTime.now()
                          .add(const Duration(days: 730)));
                  if (d != null) setState(() => _start = d);
                },
                child: const Text('Choose')),
          ]),
          _drop('Service frequency', _freq,
              enterpriseFrequencies, (v) {
            setState(() => _freq = v);
          }),
          _drop('Budget range', _budget, enterpriseBudgets,
              (v) {
            setState(() => _budget = v);
          }),
          TextField(
            controller: _req,
            maxLength: 1000,
            maxLines: 3,
            decoration: const InputDecoration(
                labelText: 'Requirements (optional, 1000)',
                border: OutlineInputBorder()),
          ),
          CheckboxListTile(
              title: const Text('Terms consent *'),
              value: _consent,
              onChanged: (v) =>
                  setState(() => _consent = v ?? false)),
          ElevatedButton(
              onPressed: _busy ? null : _submit,
              child: Text(
                  _busy ? 'Ruko…' : 'Submit inquiry →')),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _tf(TextEditingController c, String label,
      {TextInputType? kb}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: TextField(
          controller: c,
          keyboardType: kb,
          decoration: InputDecoration(
              labelText: label,
              border: const OutlineInputBorder())),
    );
  }

  Widget _drop(String label, String? value, List<String> items,
      void Function(String?) onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: DropdownButtonFormField<String>(
        initialValue: value,
        decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder()),
        items: items
            .map((e) =>
                DropdownMenuItem(value: e, child: Text(e)))
            .toList(),
        onChanged: onChanged,
      ),
    );
  }
}
