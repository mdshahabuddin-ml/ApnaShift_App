import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../auth/driver_session.dart';
import '../settings/app_settings.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';
import 'driver_home.dart';
import 'driver_register_screen.dart';

/// Driver login — driver-login.html parity: phone + password, OTP reset
/// (forgot/reset via /api/auth/*), auto-redirect when already verified.
/// Only role=driver enters; others get wrong_role message.
class DriverLoginScreen extends StatefulWidget {
  final DriverSession session;
  final AppSettings settings;
  const DriverLoginScreen(
      {super.key, required this.session, required this.settings});

  @override
  State<DriverLoginScreen> createState() => _DriverLoginScreenState();
}

String _friendly(String code) {
  switch (code) {
    case 'invalid_credentials':
      return 'Incorrect phone number or password.';
    case 'validation_failed':
      return 'Enter a 10-digit mobile number (starting with 6-9) and a password.';
    case 'too_many_attempts':
      return 'Too many attempts — try again in 15 minutes.';
    case 'wrong_role':
      return 'This number does not belong to a driver — a customer/admin number will not work here.';
    case 'driver_unverified':
      return 'Your application is still PENDING — the admin will verify it.';
    case 'driver_inactive':
      return 'Account deactivated — contact support.';
    case 'network_error':
      return 'Unable to connect to the server.';
    case 'api_base_url_missing':
      return 'API URL is not set — run with flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 (emulator) or http://<laptop-LAN-IP>:3000 (phone).';
    default:
      return 'Login failed ($code). Try again.';
  }
}

class _DriverLoginScreenState extends State<DriverLoginScreen> {
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;
  bool _otpMode = false;
  final _otpPhone = TextEditingController();
  final _otp = TextEditingController();
  final _newPass = TextEditingController();

  @override
  void dispose() {
    _phone.dispose();
    _pass.dispose();
    _otpPhone.dispose();
    _otp.dispose();
    _newPass.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.session
        .login(phone: _phone.text.trim(), password: _pass.text);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      setState(() => _error = _friendly(err));
      return;
    }
    Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => DriverHome(
            session: widget.session, settings: widget.settings)));
  }

  Future<void> _sendOtp() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.session.api.post('/api/auth/forgot-password',
          body: {'phone': _otpPhone.text.trim()});
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('OTP sent (in dev, debug_otp is in the response).')));
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
    return AppScaffold(
      settings: widget.settings,
      title: 'Driver Login',
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('Driver',
              style: TextStyle(
                  color: appNavy,
                  fontSize: 26,
                  fontWeight: FontWeight.w800)),
          const Text('Verified drivers only',
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
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'Driver mobile number',
                  border: OutlineInputBorder())),
          const SizedBox(height: 12),
          TextField(
              controller: _pass,
              obscureText: true,
              decoration: const InputDecoration(
                  labelText: 'Password',
                  border: OutlineInputBorder()),
              onSubmitted: (_) => _go()),
          const SizedBox(height: 16),
          ElevatedButton(
              onPressed: _busy ? null : _go,
              child: Text(_busy ? 'Please wait…' : 'Login →')),
          TextButton(
              onPressed: () =>
                  setState(() => _otpMode = !_otpMode),
              child: const Text('Forgot password / OTP →')),
          if (_otpMode) ...[
            TextField(
                controller: _otpPhone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                    labelText: 'OTP phone',
                    border: OutlineInputBorder())),
            const SizedBox(height: 8),
            ElevatedButton(
                onPressed: _busy ? null : _sendOtp,
                child: const Text('Send OTP')),
            const SizedBox(height: 8),
            TextField(
                controller: _otp,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                    labelText: 'OTP (6-digit)',
                    border: OutlineInputBorder())),
            const SizedBox(height: 8),
            TextField(
                controller: _newPass,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: 'New password (8+)',
                    border: OutlineInputBorder())),
            const SizedBox(height: 8),
            ElevatedButton(
                onPressed: _busy ? null : _reset,
                child: const Text('Reset password')),
          ],
          TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => DriverRegisterScreen(
                      session: widget.session,
                      settings: widget.settings))),
              child: const Text('New driver? Register →')),
        ],
      ),
    );
  }
}
