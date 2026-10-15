import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../auth/admin_session.dart';
import '../auth/session.dart';
import '../config/api_config.dart';
import '../settings/app_settings.dart';
import 'admin_login_screen.dart';
import 'staff_login_screen.dart';

const navy = Color(0xFF0A2340);
const yellow = Color(0xFFFFB200);

/// Customer login (ye app customer-only hai).
/// Driver/admin number se login backend accept kar leta hai (teeno table),
/// par Session use 'wrong_role' bolke turant logout kar deta hai — taaki
/// bookings wali 403 screen kabhi na dikhe. Staff web panel use kare.
class LoginScreen extends StatefulWidget {
  final Session session;
  final AdminSession? adminSession;
  final AppSettings? settings;
  const LoginScreen(
      {super.key, required this.session, this.adminSession, this.settings});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

String _friendly(String code) {
  switch (code) {
    case 'invalid_credentials':
      return 'Galat number ya password. Pehli baar hai? Create Account dabao.';
    case 'validation_failed':
      return '10-digit mobile (6-9 se shuru) + sahi password likho.';
    case 'too_many_attempts':
      return 'Bahut tries — 15 minute ruk ke retry karo.';
    case 'wrong_role':
      return 'Ye number driver/staff ka hai. Customer app me customer number se login karo (staff web panel use kare).';
    case 'phone_taken':
      return 'Ye number already registered hai — Login dabao.';
    case 'network_error':
      return 'Server se baat nahi ho payi. Server $apiBaseUrl chal raha hai? (local ke liye --dart-define=API_BASE_URL=$apiLocalEmulatorUrl use karo)';
    default:
      return 'Login fail ($code). Server $apiBaseUrl chal raha hai?';
  }
}

class _LoginScreenState extends State<LoginScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  bool _registerMode = false;
  String? _error;
  bool _busy = false;
  // OTP reset (user-auth.html modal parity) — sirf login mode me.
  bool _otpMode = false;
  final _otpPhone = TextEditingController();
  final _otp = TextEditingController();
  final _newPass = TextEditingController();

  Future<void> _go() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    String? err;
    try {
      err = _registerMode
          ? await widget.session.register(
              name: _name.text.trim(), phone: _phone.text.trim(), password: _pass.text)
          : await widget.session.login(phone: _phone.text.trim(), password: _pass.text);
    } catch (_) {
      err = 'network_error';
    }
    if (!mounted) return;
    if (err == null) {
      // Success: Session notify se main.dart ka home CustomerHome ban chuka
      // hai — ye pushed LoginScreen pop karo taaki user home dekhe.
      // Nahi to user Login screen par hi atka rehta hai (bug).
      setState(() {
        _busy = false;
        _error = null;
      });
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _error = _friendly(err!);
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _pass.dispose();
    _otpPhone.dispose();
    _otp.dispose();
    _newPass.dispose();
    super.dispose();
  }

  Future<void> _sendOtp() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final d = await widget.session.api.post('/api/auth/forgot-password',
          body: {'phone': _otpPhone.text.trim()});
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(d['debug_otp'] != null
              ? 'OTP: ${d['debug_otp']} (dev mode)'
              : 'OTP bheja — SMS/WhatsApp dekho.')));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendly(e.code);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendly('network_error');
      });
    }
  }

  Future<void> _reset() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.session.api.post('/api/auth/reset-password', body: {
        'phone': _otpPhone.text.trim(),
        'otp': _otp.text.trim(),
        'new_password': _newPass.text,
      });
      if (!mounted) return;
      setState(() {
        _busy = false;
        _otpMode = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Password reset — ab login karo.')));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendly(e.code);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendly('network_error');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: navy,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('ApnaShift', style: TextStyle(color: Colors.white, fontSize: 32, fontWeight: FontWeight.w800)),
                const Text('SHIFTING • TRANSPORT', style: TextStyle(color: yellow, letterSpacing: 3, fontSize: 12)),
                const SizedBox(height: 32),
                if (_error != null)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(10)),
                    child: Text(_error!, style: const TextStyle(color: Colors.red)),
                  ),
                if (_error != null) const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _ModeTab(
                        label: 'Login',
                        selected: !_registerMode,
                        onTap: () => setState(() => _registerMode = false),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _ModeTab(
                        label: 'Create Account',
                        selected: _registerMode,
                        onTap: () => setState(() => _registerMode = true),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (_registerMode)
                  TextField(
                    controller: _name,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Full name',
                      labelStyle: TextStyle(color: Colors.white70),
                      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                    ),
                  ),
                if (_registerMode) const SizedBox(height: 12),
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    labelText: 'Mobile number',
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
                  child: Text(_busy ? 'Ruko…' : (_registerMode ? 'Create Account →' : 'Login →'),
                      style: const TextStyle(fontWeight: FontWeight.w800)),
                ),
                if (!_registerMode)
                  TextButton(
                    onPressed: () =>
                        setState(() => _otpMode = !_otpMode),
                    child: const Text('Password bhool gaye? OTP se reset →',
                        style: TextStyle(color: Colors.white70)),
                  ),
                if (!_registerMode && _otpMode) ...[
                  TextField(
                    controller: _otpPhone,
                    keyboardType: TextInputType.phone,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'OTP mobile number',
                      labelStyle: TextStyle(color: Colors.white70),
                      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                    ),
                  ),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: _busy ? null : _sendOtp,
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.white24, foregroundColor: Colors.white),
                    child: const Text('Send OTP'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _otp,
                    keyboardType: TextInputType.number,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'OTP (6-digit)',
                      labelStyle: TextStyle(color: Colors.white70),
                      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _newPass,
                    obscureText: true,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'New password (8+)',
                      labelStyle: TextStyle(color: Colors.white70),
                      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                    ),
                  ),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: _busy ? null : _reset,
                    style: ElevatedButton.styleFrom(backgroundColor: yellow, foregroundColor: navy),
                    child: const Text('Reset password',
                        style: TextStyle(fontWeight: FontWeight.w800)),
                  ),
                ],
                TextButton(
                  onPressed: () {
                    final a = widget.adminSession;
                    final s = widget.settings;
                    if (a != null && s != null) {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                            builder: (_) => AdminLoginScreen(
                                session: a, settings: s)),
                      );
                    } else {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                            builder: (_) => const StaffLoginScreen()),
                      );
                    }
                  },
                  child: const Text('Staff ho? Admin login →', style: TextStyle(color: Colors.white70)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Login / Create Account toggle tab.
class _ModeTab extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _ModeTab({required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: selected ? yellow : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: selected ? yellow : Colors.white38),
        ),
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: selected ? navy : Colors.white70,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}
