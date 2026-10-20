import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api/api_client.dart';
import '../auth/admin_session.dart';
import '../auth/session.dart';
import '../config/api_config.dart';
import '../settings/app_settings.dart';
import 'admin_login_screen.dart';
import 'staff_login_screen.dart';

const navy = Color(0xFF0A2340);
const yellow = Color(0xFFFFB200);

const _bg = Color(0xFFEDF1F6);
const _muted = Color(0xFF5B6B82);
const _line = Color(0xFFD9E1EC);
const _red = Color(0xFFD93025);

/// Customer login — desktop reference (user-auth.html) ka mobile adaptation:
/// navy/yellow branding, promo section, Login/Create Account tabs, +91 phone,
/// password show/hide, "Keep me logged in", Forgot Password, error banner.
/// Backend flow unchanged: Session.login/register + OTP reset + wrong_role
/// guard (driver/staff numbers turant logout — customer-only app).
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
      return 'Incorrect phone number or password. First time here? Tap Create Account.';
    case 'validation_failed':
      return 'Enter a 10-digit mobile number (starting with 6-9) and the correct password.';
    case 'too_many_attempts':
      return 'Too many attempts — please try once after 15 minutes.';
    case 'wrong_role':
      return 'This number belongs to a driver/staff member. In the customer app, log in with a customer number (staff should use the web panel).';
    case 'phone_taken':
      return 'This number is already registered — tap Login.';
    case 'network_error':
      return 'Unable to connect to the server. Is the server running at $apiBaseUrl? (for local use --dart-define=API_BASE_URL=$apiLocalEmulatorUrl)';
    case 'api_base_url_missing':
      return 'API URL is not set. Run flutter run with --dart-define=API_BASE_URL=$apiLocalEmulatorUrl (emulator) or http://<laptop-LAN-IP>:3000 (phone).';
    default:
      return 'Login failed ($code). Is the server running at $apiBaseUrl?';
  }
}

class _LoginScreenState extends State<LoginScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  bool _registerMode = false;
  bool _obscure = true;
  bool _keepLoggedIn = true;
  String? _error;
  String? _nameError;
  String? _phoneError;
  String? _passError;
  bool _busy = false;
  // OTP reset (user-auth.html modal parity) — sirf login mode me.
  bool _otpMode = false;
  final _otpPhone = TextEditingController();
  final _otp = TextEditingController();
  final _newPass = TextEditingController();

  String _normalizePhone(String v) {
    var d = v.replaceAll(RegExp(r'\D'), '');
    if (d.length == 12 && d.startsWith('91')) d = d.substring(2);
    if (d.length == 11 && d.startsWith('0')) d = d.substring(1);
    return d;
  }

  bool _validPhone(String d) => RegExp(r'^[6-9][0-9]{9}$').hasMatch(d);

  Future<void> _go() async {
    final phone = _normalizePhone(_phone.text);
    setState(() {
      _nameError = null;
      _phoneError = null;
      _passError = null;
      _error = null;
    });
    var bad = false;
    if (_registerMode && _name.text.trim().length < 2) {
      _nameError = 'Full name must be at least 2 characters.';
      bad = true;
    }
    if (!_validPhone(phone)) {
      _phoneError =
          'Enter a 10-digit Indian mobile number (starting with 6-9). +91/spaces allowed.';
      bad = true;
    }
    if (_pass.text.isEmpty) {
      _passError = 'Enter the password.';
      bad = true;
    } else if (_registerMode && _pass.text.length < 8) {
      _passError = 'Password must be at least 8 characters.';
      bad = true;
    }
    if (bad) {
      setState(() {});
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    String? err;
    try {
      err = _registerMode
          ? await widget.session.register(
              name: _name.text.trim(),
              phone: phone,
              password: _pass.text,
              persist: _keepLoggedIn)
          : await widget.session.login(
              phone: phone, password: _pass.text, persist: _keepLoggedIn);
    } catch (_) {
      err = 'network_error';
    }
    if (!mounted) return;
    if (err == null) {
      // Success: Session notify se main.dart ka home CustomerHome ban chuka
      // hai — ye pushed LoginScreen pop karo taaki user home dekhe.
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
          body: {'phone': _normalizePhone(_otpPhone.text)});
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(d['debug_otp'] != null
              ? 'OTP: ${d['debug_otp']} (dev mode)'
              : 'OTP sent — check SMS/WhatsApp.')));
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
        'phone': _normalizePhone(_otpPhone.text),
        'otp': _otp.text.trim(),
        'new_password': _newPass.text,
      });
      if (!mounted) return;
      setState(() {
        _busy = false;
        _otpMode = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Password reset — now log in.')));
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
      backgroundColor: _bg,
      body: SafeArea(
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _brandBar(),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _promoCard(),
                    const SizedBox(height: 16),
                    _authCard(),
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
                      child: const Text('Are you a staff member? Admin login →',
                          style: TextStyle(color: _muted)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _brandBar() {
    return Container(
      color: navy,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: const Row(
        children: [
          Text('Apna',
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 22,
                  fontWeight: FontWeight.w800)),
          Text('Shift',
              style: TextStyle(
                  color: yellow, fontSize: 22, fontWeight: FontWeight.w800)),
          SizedBox(width: 8),
          Text('SHIFTING • TRANSPORT',
              style: TextStyle(
                  color: Colors.white70, fontSize: 10, letterSpacing: 2)),
        ],
      ),
    );
  }

  Widget _promoCard() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFFE2ECFA), Color(0xFFF8EDD6)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFFD9E8FB),
              borderRadius: BorderRadius.circular(999),
            ),
            child: const Text('Safe • Reliable • Affordable',
                style: TextStyle(
                    color: navy, fontWeight: FontWeight.w700, fontSize: 12)),
          ),
          const SizedBox(height: 12),
          RichText(
            text: const TextSpan(
              style: TextStyle(
                  fontSize: 30,
                  height: 1.15,
                  fontWeight: FontWeight.w800,
                  color: navy),
              children: [
                TextSpan(text: 'Your Trusted\n'),
                TextSpan(text: 'Shifting & Transport\n', style: TextStyle(color: Color(0xFFF5A301))),
                TextSpan(text: 'Partner'),
              ],
            ),
          ),
          const SizedBox(height: 8),
          const Text('Book vehicles, track your move and ride with verified drivers — all in one place.',
              style: TextStyle(color: _muted, fontSize: 13)),
          const SizedBox(height: 14),
          const _Feat(icon: Icons.local_shipping, title: 'Easy Booking', sub: 'Quick & convenient'),
          const _Feat(icon: Icons.verified_user, title: 'Verified Drivers', sub: 'Safe & secure rides'),
          const _Feat(icon: Icons.location_on, title: 'Live Tracking', sub: 'Know where your vehicle is'),
          const _Feat(icon: Icons.currency_rupee, title: 'Transparent Pricing', sub: 'No hidden charges'),
        ],
      ),
    );
  }

  Widget _authCard() {
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
              color: navy.withValues(alpha: 0.10),
              blurRadius: 40,
              offset: const Offset(0, 12)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          RichText(
            text: const TextSpan(
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800),
              children: [
                TextSpan(text: 'Apna', style: TextStyle(color: navy)),
                TextSpan(text: 'Shift', style: TextStyle(color: Color(0xFFF5A301))),
                TextSpan(text: ' Account', style: TextStyle(color: navy)),
              ],
            ),
          ),
          const SizedBox(height: 4),
          const Text('Log in to book a shifting service or create a new account.',
              style: TextStyle(color: _muted, fontSize: 13)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _AuthTab(
                  label: 'Login',
                  icon: Icons.person,
                  selected: !_registerMode,
                  onTap: () => setState(() => _registerMode = false),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _AuthTab(
                  label: 'Create Account',
                  icon: Icons.people,
                  selected: _registerMode,
                  onTap: () => setState(() => _registerMode = true),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFFDECEA),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: _red),
              ),
              child: Text(_error!, style: const TextStyle(color: Color(0xFF7A1F14), fontSize: 13, fontWeight: FontWeight.w600)),
            ),
          if (_error != null) const SizedBox(height: 12),
          if (_registerMode)
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: InputDecoration(
                labelText: 'Full name *',
                hintText: 'e.g. Rahul Sharma',
                prefixIcon: const Icon(Icons.badge_outlined),
                border: const OutlineInputBorder(),
                errorText: _nameError,
              ),
            ),
          if (_registerMode) const SizedBox(height: 12),
          const Text('Phone number *',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: navy)),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
                decoration: BoxDecoration(
                  border: Border.all(color: _line),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Text('+91',
                    style: TextStyle(fontWeight: FontWeight.w700, color: navy)),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                    LengthLimitingTextInputFormatter(14),
                  ],
                  decoration: InputDecoration(
                    hintText: '10-digit mobile number',
                    suffixIcon: const Icon(Icons.phone, color: Color(0xFFD81B60)),
                    border: const OutlineInputBorder(),
                    errorText: _phoneError,
                  ),
                  onSubmitted: (_) => _go(),
                ),
              ),
            ],
          ),
          const Text('Enter a 10-digit Indian mobile number. +91 or spaces are allowed.',
              style: TextStyle(color: _muted, fontSize: 11)),
          const SizedBox(height: 12),
          const Text('Password *',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: navy)),
          const SizedBox(height: 6),
          TextField(
            controller: _pass,
            obscureText: _obscure,
            decoration: InputDecoration(
              hintText: _registerMode ? 'Min 8 characters' : 'Your password',
              prefixIcon: const Icon(Icons.lock_outline),
              suffixIcon: IconButton(
                icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
              border: const OutlineInputBorder(),
              errorText: _passError,
            ),
            onSubmitted: (_) => _go(),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Checkbox(
                value: _keepLoggedIn,
                activeColor: navy,
                onChanged: (v) => setState(() => _keepLoggedIn = v ?? true),
              ),
              const Text('Keep me logged in', style: TextStyle(fontSize: 12)),
              const Spacer(),
              if (!_registerMode)
                TextButton(
                  onPressed: () => setState(() => _otpMode = !_otpMode),
                  child: const Text('Forgot password?'),
                ),
            ],
          ),
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: _busy ? null : _go,
            style: ElevatedButton.styleFrom(
                backgroundColor: yellow,
                foregroundColor: navy,
                padding: const EdgeInsets.all(16),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12))),
            child: _busy
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: navy))
                : Text(_registerMode ? 'Create Account  →' : 'Login  →',
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          ),
          if (!_registerMode && _otpMode) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _otpPhone,
              keyboardType: TextInputType.phone,
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
              ],
              decoration: const InputDecoration(
                labelText: 'OTP mobile number',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: _busy ? null : _sendOtp,
              style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.white24,
                  foregroundColor: navy),
              child: const Text('Send OTP'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _otp,
              keyboardType: TextInputType.number,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(6),
              ],
              decoration: const InputDecoration(
                labelText: 'OTP (6-digit)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _newPass,
              obscureText: true,
              decoration: const InputDecoration(
                labelText: 'New password (8+)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: _busy ? null : _reset,
              style: ElevatedButton.styleFrom(
                  backgroundColor: yellow, foregroundColor: navy),
              child: const Text('Reset password',
                  style: TextStyle(fontWeight: FontWeight.w800)),
            ),
          ],
          const SizedBox(height: 12),
          const Row(
            children: [
              Expanded(child: Divider()),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: Text('OR', style: TextStyle(color: _muted, fontSize: 12)),
              ),
              Expanded(child: Divider()),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _busy
                ? null
                : () => setState(() => _registerMode = true),
            icon: const Icon(Icons.people, size: 18),
            label: const Text('Create a new account'),
            style: OutlinedButton.styleFrom(
                foregroundColor: navy,
                padding: const EdgeInsets.all(14),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12))),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('New here? ', style: TextStyle(fontSize: 12, color: _muted)),
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() => _registerMode = true),
                child: const Text('Create an account'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Feat extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  const _Feat({required this.icon, required this.title, required this.sub});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: const BoxDecoration(
              color: Colors.white,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: Color(0xFF1A73E8)),
          ),
          const SizedBox(width: 12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, color: navy, fontSize: 14)),
              Text(sub, style: const TextStyle(color: _muted, fontSize: 12)),
            ],
          ),
        ],
      ),
    );
  }
}

/// Login / Create Account toggle tab (reference: navy active pill).
class _AuthTab extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  const _AuthTab(
      {required this.label,
      required this.icon,
      required this.selected,
      required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: selected ? navy : const Color(0xFFEDF1F6),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon,
                size: 16, color: selected ? yellow : navy),
            const SizedBox(width: 6),
            Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: selected ? yellow : navy,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
