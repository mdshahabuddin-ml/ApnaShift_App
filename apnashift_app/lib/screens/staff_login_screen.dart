import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/admin_api.dart';
import '../api/api_client.dart';
import '../config/api_config.dart';
import '../settings/app_settings.dart';
import 'login_screen.dart';
import 'super_admin_home.dart';

/// Staff login (phone + password). Sirf super_admin andar jata hai —
/// plain admin ko "super admin only" message, koi bypass nahi.
class StaffLoginScreen extends StatefulWidget {
  final AppSettings? settings;
  const StaffLoginScreen({super.key, this.settings});

  @override
  State<StaffLoginScreen> createState() => _StaffLoginScreenState();
}

String _friendlyStaff(String code) {
  switch (code) {
    case 'invalid_credentials':
      return 'Incorrect phone number or password.';
    case 'validation_failed':
      return 'Enter a 10-digit mobile number (starting with 6-9).';
    case 'too_many_attempts':
      return 'Too many attempts — try again in 15 minutes.';
    case 'not_super_admin':
      return 'This admin account is not a super admin — log in with a super admin account.';
    case 'api_base_url_missing':
      return 'API URL is not set — run with flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 (emulator) or http://<laptop-LAN-IP>:3000 (phone).';
    case 'network_error':
      return 'Unable to connect to the server. Is the server running at $apiBaseUrl? Emulator: --dart-define=API_BASE_URL=$apiLocalEmulatorUrl; phone: --dart-define=API_BASE_URL=http://<laptop-LAN-IP>:3000.';
    default:
      return 'Login failed ($code). Is the server reachable?';
  }
}

class _StaffLoginScreenState extends State<StaffLoginScreen> {
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;
  bool _obscurePass = true;

  static final _phoneRe = RegExp(r'^[6-9][0-9]{9}$');

  Future<void> _go() async {
    final phone = _phone.text.trim();
    if (!_phoneRe.hasMatch(phone)) {
      setState(() => _error = _friendlyStaff('validation_failed'));
      return;
    }
    if (_pass.text.isEmpty) {
      setState(() => _error = 'Enter the password.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ApiClient();
      final r = await AdminApi(api).login(phone: phone, password: _pass.text);
      if (r.role != 'super_admin') {
        api.close();
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = _friendlyStaff('not_super_admin');
        });
        return;
      }
      api.setToken(r.token);
      const store = FlutterSecureStorage();
      await store.write(key: 'apnashift_admin_token', value: r.token);
      if (!mounted) return;
      setState(() => _busy = false);
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
            builder: (_) => SuperAdminHome(
                api: api, name: r.name, settings: widget.settings)),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendlyStaff(e.code);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendlyStaff('network_error');
      });
    }
  }

  @override
  void dispose() {
    _phone.dispose();
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: navy,
      appBar: AppBar(title: const Text('Staff Login'), backgroundColor: navy, foregroundColor: Colors.white),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Super Admin', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800)),
                const Text('Authorized staff only', style: TextStyle(color: Colors.white70)),
                const SizedBox(height: 24),
                if (_error != null)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(10)),
                    child: Text(_error!, style: const TextStyle(color: Colors.red)),
                  ),
                if (_error != null) const SizedBox(height: 12),
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    labelText: 'Admin mobile number',
                    labelStyle: TextStyle(color: Colors.white70),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _pass,
                  obscureText: _obscurePass,
                  style: const TextStyle(color: Colors.white),
                  decoration: InputDecoration(
                    labelText: 'Password',
                    labelStyle: const TextStyle(color: Colors.white70),
                    enabledBorder: const OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                    focusedBorder: const OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscurePass ? Icons.visibility_off : Icons.visibility,
                        color: Colors.white70,
                      ),
                      onPressed: () => setState(() => _obscurePass = !_obscurePass),
                    ),
                  ),
                  onSubmitted: (_) => _go(),
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: _busy ? null : _go,
                  style: ElevatedButton.styleFrom(backgroundColor: yellow, foregroundColor: navy, padding: const EdgeInsets.all(16)),
                  child: Text(_busy ? 'Please wait…' : 'Login as Super Admin →', style: const TextStyle(fontWeight: FontWeight.w800)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
