import 'package:flutter/material.dart';
import '../auth/driver_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';

/// Driver registration — driver-register.html 5-step wizard parity.
/// Backend: POST /api/drivers/register (optional extended fields OK).
/// Success: application ref + PENDING_REVIEW card -> login.
class DriverRegisterScreen extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const DriverRegisterScreen(
      {super.key, required this.session, required this.settings});

  @override
  State<DriverRegisterScreen> createState() => _DriverRegisterScreenState();
}

String _cleanPhone(String v) {
  var p = v.replaceAll(RegExp(r'[\s\-]'), '');
  if (p.startsWith('+91')) p = p.substring(3);
  if (p.startsWith('91') && p.length == 12) p = p.substring(2);
  if (p.startsWith('0') && p.length == 11) p = p.substring(1);
  return p;
}

final _phoneRe = RegExp(r'^[6-9][0-9]{9}$');
final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
final _upiRe = RegExp(r'^[\w.\-]{2,256}@[a-zA-Z]{2,64}$');

class _DriverRegisterScreenState extends State<DriverRegisterScreen> {
  int _step = 0;
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _success;

  // Step 1
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _city = TextEditingController();
  final _pass = TextEditingController();
  final _upi = TextEditingController();
  // Step 2
  String _vtype = 'pickup';
  final _vnum = TextEditingController();
  final _vmodel = TextEditingController();
  final _vyear = TextEditingController();
  final _vcap = TextEditingController();
  // Step 3
  final _dlnum = TextEditingController();
  DateTime? _dlexp;
  final _scity = TextEditingController();
  // Step 4
  final _rc = TextEditingController();
  DateTime? _ins;
  bool _c1 = false;
  bool _c2 = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    _city.dispose();
    _pass.dispose();
    _upi.dispose();
    _vnum.dispose();
    _vmodel.dispose();
    _vyear.dispose();
    _vcap.dispose();
    _dlnum.dispose();
    _scity.dispose();
    _rc.dispose();
    super.dispose();
  }

  String? _validateStep(int s) {
    if (s == 0) {
      if (_name.text.trim().length < 2) return 'Naam kam se kam 2 akshar.';
      if (!_phoneRe.hasMatch(_cleanPhone(_phone.text))) {
        return 'Phone 10 digit Indian mobile (6-9 se shuru).';
      }
      if (_email.text.trim().isNotEmpty &&
          !_emailRe.hasMatch(_email.text.trim())) {
        return 'Sahi email likho.';
      }
      if (_city.text.trim().length < 2) return 'Sheher kam se kam 2 akshar.';
      if (_pass.text.length < 8) return 'Password kam se kam 8 akshar.';
      if (_upi.text.trim().isNotEmpty &&
          !_upiRe.hasMatch(_upi.text.trim())) {
        return 'UPI ID format naam@bank jaisa ho.';
      }
    }
    if (s == 1) {
      final vn = _vnum.text.trim().toUpperCase();
      if (vn.length < 4 || vn.length > 20) {
        return 'Gaadi number 4-20 akshar.';
      }
      if (!RegExp(r'^[A-Z0-9 ]+$').hasMatch(vn)) {
        return 'Gaadi number me sirf A-Z, 0-9 aur space.';
      }
      if (_vyear.text.trim().isNotEmpty) {
        final y = int.tryParse(_vyear.text.trim());
        if (y == null || y < 1990 || y > 2100) {
          return 'Year 1990-2100 ke beech ho.';
        }
      }
      if (_vcap.text.trim().isNotEmpty) {
        final c = int.tryParse(_vcap.text.trim());
        if (c == null || c < 0 || c > 50000) {
          return 'Capacity 0-50000 kg ke beech ho.';
        }
      }
    }
    if (s == 2) {
      final dl = _dlnum.text.trim().toUpperCase();
      if (!RegExp(r'^[A-Z0-9 ]{5,25}$').hasMatch(dl)) {
        return 'License number 5-25 akshar (A-Z, 0-9, space).';
      }
      if (_dlexp == null) return 'License expiry date chuno.';
      final now = DateTime.now();
      final today =
          DateTime(now.year, now.month, now.day).add(const Duration(days: 1));
      if (!_dlexp!.isAfter(today.subtract(const Duration(days: 1)))) {
        return 'Expiry aaj ke baad ki date ho.';
      }
      if (_dlexp!.isBefore(today)) return 'Expiry aaj ke baad ki date ho.';
      if (_scity.text.trim().length < 2) {
        return 'Service city kam se kam 2 akshar.';
      }
    }
    if (s == 3) {
      if (!_c1 || !_c2) return 'Dono consent tick karo (terms + documents sahi).';
    }
    return null;
  }

  Map<String, dynamic> _fields() => {
        'name': _name.text.trim(),
        'phone': _cleanPhone(_phone.text),
        'password': _pass.text,
        if (_email.text.trim().isNotEmpty)
          'email': _email.text.trim().toLowerCase(),
        'city': _city.text.trim(),
        if (_upi.text.trim().isNotEmpty) 'upi_id': _upi.text.trim(),
        'vehicle_type': _vtype,
        'vehicle_number': _vnum.text.trim().toUpperCase(),
        if (_vmodel.text.trim().isNotEmpty)
          'vehicle_model': _vmodel.text.trim(),
        if (_vyear.text.trim().isNotEmpty)
          'vehicle_year': int.parse(_vyear.text.trim()),
        if (_vcap.text.trim().isNotEmpty)
          'capacity_kg': int.parse(_vcap.text.trim()),
        'license_number': _dlnum.text.trim().toUpperCase(),
        'license_expiry':
            '${_dlexp!.year.toString().padLeft(4, '0')}-${_dlexp!.month.toString().padLeft(2, '0')}-${_dlexp!.day.toString().padLeft(2, '0')}',
        'service_city': _scity.text.trim(),
        if (_rc.text.trim().isNotEmpty) 'rc_number': _rc.text.trim(),
        if (_ins != null)
          'insurance_expiry':
              '${_ins!.year.toString().padLeft(4, '0')}-${_ins!.month.toString().padLeft(2, '0')}-${_ins!.day.toString().padLeft(2, '0')}',
        'consent': true,
      };

  Future<void> _submit() async {
    for (var i = 0; i < 4; i++) {
      final e = _validateStep(i);
      if (e != null) {
        setState(() {
          _step = i;
          _error = e;
        });
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.session.register(_fields());
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      setState(() => _error = _friendly(err));
      return;
    }
    setState(() {
      _success = {
        'ref': widget.session.application?.ref ?? '',
        'status': widget.session.application?.status ?? 'PENDING_REVIEW',
        'at': DateTime.now().toString().split('.').first,
      };
    });
  }

  static String _friendly(String code) {
    switch (code) {
      case 'phone_taken':
        return 'Ye number already registered hai — Login dabao.';
      case 'driver_already_registered':
        return 'Ye email already registered hai.';
      case 'license_already_registered':
        return 'Ye license already registered hai.';
      case 'vehicle_already_registered':
        return 'Ye gaadi number already registered hai.';
      case 'validation_failed':
        return 'Details check karo (steps 1-4).';
      case 'too_many_attempts':
        return 'Bahut tries — 15 min ruk ke retry karo.';
      case 'network_error':
        return 'Server se baat nahi ho payi.';
      case 'api_base_url_missing':
        return 'API URL set nahi hai — flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 (emulator) ya http://<laptop-LAN-IP>:3000 (phone) se chalao.';
      default:
        return 'Register fail ($code). Retry karo.';
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_success != null) {
      return AppScaffold(
        settings: widget.settings,
        title: 'Application received',
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.check_circle,
                    size: 64, color: Colors.green),
                const SizedBox(height: 12),
                Text('Application ${_success!['ref']}',
                    style: const TextStyle(
                        fontWeight: FontWeight.w800, fontSize: 18)),
                Text('Status: ${_success!['status']}'),
                Text('Date: ${_success!['at']}'),
                const SizedBox(height: 8),
                const Text(
                    'Admin verify karega — tab tak jobs nahi dikhengi. UPI ID profile me save kar sakte ho.'),
                const SizedBox(height: 16),
                ElevatedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Driver Login →')),
              ]),
        ),
      );
    }
    return AppScaffold(
      settings: widget.settings,
      title: 'Join as Driver',
      body: Column(children: [
        if (_error != null)
          Container(
              margin: const EdgeInsets.all(12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                  color: Colors.red.shade50,
                  borderRadius: BorderRadius.circular(10)),
              child: Text(_error!,
                  style: const TextStyle(color: Colors.red))),
        Expanded(
          child: Stepper(
            currentStep: _step,
            onStepTapped: (i) => setState(() => _step = i),
            onStepContinue: () {
              final e = _validateStep(_step);
              if (e != null) {
                setState(() => _error = e);
                return;
              }
              setState(() => _error = null);
              if (_step < 4) {
                setState(() => _step += 1);
              } else {
                _submit();
              }
            },
            onStepCancel: () {
              if (_step > 0) setState(() => _step -= 1);
            },
            steps: [
              Step(
                  title: const Text('Personal'),
                  isActive: _step >= 0,
                  content: Column(children: [
                    _tf(_name, 'Full name *'),
                    _tf(_phone, 'Mobile number *',
                        kb: TextInputType.phone),
                    _tf(_email, 'Email (optional)',
                        kb: TextInputType.emailAddress),
                    _tf(_city, 'City *'),
                    _tf(_pass, 'Password (8+) *', pw: true),
                    _tf(_upi, 'UPI ID (optional, naam@bank)'),
                  ])),
              Step(
                  title: const Text('Vehicle'),
                  isActive: _step >= 1,
                  content: Column(children: [
                    DropdownButtonFormField<String>(
                        initialValue: _vtype,
                        items: const [
                          DropdownMenuItem(
                              value: 'pickup',
                              child: Text('Pickup')),
                          DropdownMenuItem(
                              value: 'mini_truck',
                              child: Text('Mini Truck')),
                          DropdownMenuItem(
                              value: 'mini_tractor',
                              child: Text('Mini Tractor')),
                        ],
                        onChanged: (v) =>
                            setState(() => _vtype = v ?? 'pickup')),
                    _tf(_vnum, 'Gaadi number * (e.g. MP09AB1234)'),
                    _tf(_vmodel, 'Model (optional)'),
                    Row(children: [
                      Expanded(child: _tf(_vyear, 'Year (1990-2100)',
                          kb: TextInputType.number)),
                      const SizedBox(width: 8),
                      Expanded(child: _tf(_vcap, 'Capacity kg (0-50000)',
                          kb: TextInputType.number)),
                    ]),
                  ])),
              Step(
                  title: const Text('Driver'),
                  isActive: _step >= 2,
                  content: Column(children: [
                    _tf(_dlnum, 'License number *'),
                    Row(children: [
                      Expanded(
                          child: Text(_dlexp == null
                              ? 'Expiry: chuno *'
                              : 'Expiry: ${_dlexp!.day}/${_dlexp!.month}/${_dlexp!.year}')),
                      TextButton(
                          onPressed: () async {
                            final d = await showDatePicker(
                                context: context,
                                firstDate: DateTime.now(),
                                lastDate: DateTime.now().add(
                                    const Duration(days: 3650)),
                                initialDate: DateTime.now().add(
                                    const Duration(days: 365)));
                            if (d != null) {
                              setState(() => _dlexp = d);
                            }
                          },
                          child: const Text('Choose')),
                    ]),
                    _tf(_scity, 'Service city *'),
                  ])),
              Step(
                  title: const Text('Documents'),
                  isActive: _step >= 3,
                  content: Column(children: [
                    _tf(_rc, 'RC number (optional)'),
                    Row(children: [
                      Expanded(
                          child: Text(_ins == null
                              ? 'Insurance expiry: optional'
                              : 'Insurance: ${_ins!.day}/${_ins!.month}/${_ins!.year}')),
                      TextButton(
                          onPressed: () async {
                            final d = await showDatePicker(
                                context: context,
                                firstDate: DateTime(2000),
                                lastDate: DateTime.now().add(
                                    const Duration(days: 3650)));
                            if (d != null) {
                              setState(() => _ins = d);
                            }
                          },
                          child: const Text('Choose')),
                    ]),
                    CheckboxListTile(
                        title: const Text(
                            'Terms accept karta hoon *'),
                        value: _c1,
                        onChanged: (v) =>
                            setState(() => _c1 = v ?? false)),
                    CheckboxListTile(
                        title: const Text(
                            'Documents sahi hain *'),
                        value: _c2,
                        onChanged: (v) =>
                            setState(() => _c2 = v ?? false)),
                  ])),
              Step(
                  title: const Text('Review'),
                  isActive: _step >= 4,
                  content: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                            '${_name.text.trim()} • ${_cleanPhone(_phone.text)}'),
                        Text(
                            '$_vtype • ${_vnum.text.trim().toUpperCase()}'),
                        Text(
                            'DL ${_dlnum.text.trim().toUpperCase()} • ${_scity.text.trim()}'),
                        const SizedBox(height: 12),
                        ElevatedButton(
                            onPressed: _busy ? null : _submit,
                            child: Text(_busy
                                ? 'Ruko…'
                                : 'Submit application →')),
                      ])),
            ],
          ),
        ),
      ]),
    );
  }

  Widget _tf(TextEditingController c, String label,
      {bool pw = false, TextInputType? kb}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: TextField(
          controller: c,
          obscureText: pw,
          keyboardType: kb,
          decoration: InputDecoration(
              labelText: label,
              border: const OutlineInputBorder())),
    );
  }
}
