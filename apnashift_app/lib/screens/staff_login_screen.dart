import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/admin_api.dart';
import '../api/api_client.dart';
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
      return 'Galat number ya password.';
    case 'validation_failed':
      return '10-digit mobile (6-9 se shuru) likho.';
    case 'too_many_attempts':
      return 'Bahut tries — 15 minute ruk ke retry karo.';
    case 'not_super_admin':
      return 'Ye admin account super admin nahi hai — super admin se login karo.';
    default:
      return 'Login fail ($code). Server reachable hai?';
  }
}

class _StaffLoginScreenState extends State<StaffLoginScreen> {
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;

  static final _phoneRe = RegExp(r'^[6-9][0-9]{9}$');

  Future<void> _go() async {
    final phone = _phone.text.trim();
    if (!_phoneRe.hasMatch(phone)) {
      setState(() => _error = _friendlyStaff('validation_failed'));
      return;
    }
    if (_pass.text.isEmpty) {
      setState(() => _error = 'Password likho.');
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
        _error = 'Server se baat nahi ho payi.';
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
                  obscureText: true,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    labelText: 'Password',
                    labelStyle: TextStyle(color: Colors.white70),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                  ),
                  onSubmitted: (_) => _go(),
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: _busy ? null : _go,
                  style: ElevatedButton.styleFrom(backgroundColor: yellow, foregroundColor: navy, padding: const EdgeInsets.all(16)),
                  child: Text(_busy ? 'Ruko…' : 'Login as Super Admin →', style: const TextStyle(fontWeight: FontWeight.w800)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
