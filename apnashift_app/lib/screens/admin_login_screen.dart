import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../config/api_config.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_home.dart';
import 'staff_login_screen.dart';

/// Admin login — admin-login.html parity: phone + password (email typed
/// explicitly blocked with "use phone" message). Both admin + super_admin
/// enter AdminHome; super_admin additionally gets SuperAdmin overview link.
class AdminLoginScreen extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminLoginScreen(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminLoginScreen> createState() => _AdminLoginScreenState();
}

String _friendly(String code) {
  switch (code) {
    case 'invalid_credentials':
      return 'Galat number ya password.';
    case 'validation_failed':
      return 'Phone digits me likho (email nahi — phone use karo).';
    case 'too_many_attempts':
      return 'Bahut tries — 15 minute ruk ke retry karo.';
    case 'not_staff':
      return 'Ye account staff ka nahi hai.';
    case 'network_error':
      return 'Server se baat nahi ho payi. Server $apiBaseUrl chal raha hai? Emulator: --dart-define=API_BASE_URL=$apiLocalEmulatorUrl; phone: run-phone.ps1 (ya --dart-define=API_BASE_URL=http://<laptop-LAN-IP>:3000).';
    case 'api_base_url_missing':
      return 'API URL set nahi hai — flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 (emulator) ya http://<laptop-LAN-IP>:3000 (phone) se chalao.';
    default:
      return 'Login fail ($code). Retry karo.';
  }
}

final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

class _AdminLoginScreenState extends State<AdminLoginScreen> {
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;
  bool _obscurePass = true;

  @override
  void dispose() {
    _phone.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    final raw = _phone.text.trim();
    if (_emailRe.hasMatch(raw)) {
      setState(() => _error = 'Email not supported, use phone.');
      return;
    }
    if (raw.isEmpty || _pass.text.isEmpty) {
      setState(() => _error = _friendly('validation_failed'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.session
        .login(phone: raw, password: _pass.text);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      setState(() => _error = _friendly(err));
      return;
    }
    Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => AdminHome(
            session: widget.session, settings: widget.settings)));
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Admin Login',
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('Admin',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
          const Text('Staff only — role server se verify hota hai',
              style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 16),
          if (_error != null)
            Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(_error!,
                    style: const TextStyle(color: Colors.red))),
          if (_error != null) const SizedBox(height: 12),
          TextField(
              controller: _phone,
              keyboardType: TextInputType.text,
              decoration: const InputDecoration(
                  labelText: 'Admin mobile number',
                  hintText: 'Phone (email nahi)',
                  border: OutlineInputBorder())),
          const SizedBox(height: 12),
          TextField(
              controller: _pass,
              obscureText: _obscurePass,
              decoration: InputDecoration(
                  labelText: 'Password',
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    icon: Icon(
                      _obscurePass
                          ? Icons.visibility_off
                          : Icons.visibility,
                      color: Colors.grey,
                    ),
                    onPressed: () =>
                        setState(() => _obscurePass = !_obscurePass),
                  )),
              onSubmitted: (_) => _go()),
          const SizedBox(height: 16),
          ElevatedButton(
              onPressed: _busy ? null : _go,
              child: Text(_busy ? 'Ruko…' : 'Login as Admin →')),
          TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) =>
                      StaffLoginScreen(settings: widget.settings))),
              child: const Text(
                  'Super Admin overview (sirf super_admin) →')),
        ],
      ),
    );
  }
}
