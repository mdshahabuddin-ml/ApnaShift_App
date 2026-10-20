import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';

// "Moving Soon?" first-visit callback popup — website parity
// (apnashift-frontend/callback-popup.js). App ki pehli launch par guest
// (koi bhi session nahi) ko EK hi baar dikhta hai — koi button click nahi.
// Reference design: centered white card + dark overlay, ✕ close, 4 stacked
// fields (From City, To City, Your Name, Phone Number*) — pehle field ka
// orange border — aur full-width orange "Get a Callback" button.
//
// Policy (website ke `ApnaShiftCallbackPopupConfig` ke barabar):
//   - guestsOnly: sirf logged-out visitor (customer + driver + admin nahi)
//   - reshowAfterDays: 0 = sirf ek baar; >0 = dismiss ke itne din baad
//   - State flutter_secure_storage me JSON {"s":..,"t":epochMs} — key
//     `apnashift-callback-popup` (website localStorage key ke barabar).
//     Storage fail par defaults (fail-soft, AppSettings pattern).
//
// Submit: required validation + Indian mobile ([6-9] + 9 digit, +91/91/0
// normalize — help_screen/enterprise_api rule) → success card + WhatsApp
// handoff (wa.me/918757160137, help.html parity — koi naya endpoint nahi).

const String callbackPopupStorageKey = 'apnashift-callback-popup';

/// Storage backend — default flutter_secure_storage (AppSettings wala
/// pattern, 2s timeout + fail-soft). Tests map-backed fake inject karti
/// hain — policy verify karne ke liye koi naya dependency nahi.
abstract class CallbackPopupStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureCallbackPopupStorage implements CallbackPopupStorage {
  const SecureCallbackPopupStorage([FlutterSecureStorage? store])
      : _store = store ?? const FlutterSecureStorage();

  final FlutterSecureStorage _store;

  @override
  Future<String?> read(String key) async {
    try {
      return await _store.read(key: key).timeout(const Duration(seconds: 2));
    } catch (_) {
      return null; // locked device / no channel — fail-soft
    }
  }

  @override
  Future<void> write(String key, String value) async {
    try {
      await _store
          .write(key: key, value: value)
          .timeout(const Duration(seconds: 2));
    } catch (_) {
      /* fail-soft — popup dobara aa jaye to bhi page nahi tootega */
    }
  }

  @override
  Future<void> delete(String key) async {
    try {
      await _store.delete(key: key).timeout(const Duration(seconds: 2));
    } catch (_) {
      /* fail-soft */
    }
  }
}

/// First-visit policy + persistence (website callback-popup.js ke barabar).
class CallbackPopupStore {
  CallbackPopupStore({CallbackPopupStorage? storage})
      : _storage = storage ?? const SecureCallbackPopupStorage();

  static const reshowAfterDays = 0; // 0 = first-visit: sirf ek baar

  final CallbackPopupStorage _storage;

  Future<String?> _readRaw() async {
    // async/await = backend error bhi andar hi dab jaye.
    try {
      return await _storage.read(callbackPopupStorageKey);
    } catch (_) {
      return null;
    }
  }

  Future<void> write(String status) async {
    try {
      final v = jsonEncode({
        's': status,
        't': DateTime.now().millisecondsSinceEpoch,
      });
      await _storage.write(callbackPopupStorageKey, v);
    } catch (_) {
      /* fail-soft */
    }
  }

  /// Current status: "shown" | "dismissed" | "submitted" | null (kabhi nahi dikha).
  Future<String?> status() async {
    final raw = await _readRaw();
    if (raw == null || raw.isEmpty) return null;
    try {
      final o = jsonDecode(raw);
      if (o is Map) return '${o['s'] ?? ''}';
    } catch (_) {
      /* legacy/plain value — treat as unknown */
    }
    return null;
  }

  /// Configured first-visit policy (see header).
  Future<bool> shouldShow() async {
    final raw = await _readRaw();
    String s = '';
    int t = 0;
    if (raw != null && raw.isNotEmpty) {
      try {
        final o = jsonDecode(raw);
        if (o is Map) {
          s = '${o['s'] ?? ''}';
          t = (o['t'] as num?)?.toInt() ?? 0;
        }
      } catch (_) {
        return false; // corrupt state = dobara tang mat karo
      }
    } else {
      return true; // genuinely new visitor
    }
    if (s == 'submitted') return false;
    if (reshowAfterDays <= 0) return false;
    return DateTime.now().millisecondsSinceEpoch - t >= reshowAfterDays * 86400000;
  }

  /// Tests / dev reset.
  Future<void> reset() async {
    try {
      await _storage.delete(callbackPopupStorageKey);
    } catch (_) {
      /* fail-soft */
    }
  }
}

/// Widget-test env (`FLUTTER_TEST=true`): auto-popup band — test process me
/// secure-storage ka platform channel hota hi nahi (future hang) aur tests
/// ke beech marketing popup chahiye bhi nahi. CallbackPopup widget +
/// CallbackPopupStore policy apne tests me injected storage se cover hoti
/// hai (test/callback_popup_test.dart).
bool get _runningInWidgetTest {
  try {
    return Platform.environment['FLUTTER_TEST'] == 'true';
  } catch (_) {
    return false;
  }
}

/// Single gate (main.dart par UpdateCheckService jaisa guard): dobara
/// show nahi hone dete, update-dialog ke saath race nahi, dismiss state
/// close par persist hoti hai.
class CallbackPopupGate {
  CallbackPopupGate._();

  static final CallbackPopupGate instance = CallbackPopupGate._();

  bool checked = false;
  bool open = false;

  /// [guest] = koi bhi session (customer/driver/admin) nahi. call site
  /// (main.dart) ready-state + update-dialog apni taraf dekhta hai.
  Future<void> maybeShow(BuildContext context, {required bool guest}) async {
    if (open || checked) return;
    if (_runningInWidgetTest) {
      checked = true;
      return;
    }
    if (!guest) {
      checked = true;
      return;
    }
    checked = true;
    final store = CallbackPopupStore();
    if (!await store.shouldShow()) return;
    if (!context.mounted) return;
    open = true;
    await store.write('shown');
    if (!context.mounted) {
      open = false;
      return;
    }
    // Koi artificial delay nahi — showDialog khud next frame par animate
    // hota hai, tab tak home paint ho chuka hota hai. (Timer-free = widget
    // tests me pending-timer invariant bhi tutta nahi.)
    try {
      await showDialog<void>(
        context: context,
        barrierDismissible: true, // backdrop tap = close (navigation free)
        barrierColor: const Color(0xE6161619), // website overlay ke barabar
        builder: (_) => CallbackPopup(store: store),
      );
    } finally {
      open = false;
    }
    // ✕ / backdrop / back se band hua aur submit nahi hua → "dismissed".
    if (await store.status() == 'shown') await store.write('dismissed');
  }

  @visibleForTesting
  void reset() {
    checked = false;
    open = false;
  }
}

/// Popup body (white card). Reference design ke colors/type ek mein copy.
class CallbackPopup extends StatefulWidget {
  final CallbackPopupStore store;
  const CallbackPopup({super.key, required this.store});

  @override
  State<CallbackPopup> createState() => _CallbackPopupState();
}

const _orange = Color(0xFFFF6B00);
const _ink = Color(0xFF0B1F3A);
const _slate = Color(0xFF64748B);
const _line = Color(0xFFDBE4F0);
const _red = Color(0xFFDC2626);
const _green = Color(0xFF12A150);
const _waNumber = '918757160137';

class _CallbackPopupState extends State<CallbackPopup> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  late final List<FocusNode> _nodes =
      List<FocusNode>.generate(4, (_) => FocusNode());
  final List<String?> _errs = List<String?>.filled(4, null);
  int _active = 0; // pehle field ka orange border (reference design)
  bool _submitted = false;

  static final _phoneRe = RegExp(r'^[6-9][0-9]{9}$');

  @override
  void initState() {
    super.initState();
    for (var i = 0; i < _nodes.length; i++) {
      _nodes[i].addListener(() {
        if (_nodes[i].hasFocus && _active != i && mounted) {
          setState(() => _active = i);
        }
      });
    }
  }

  @override
  void dispose() {
    for (final n in _nodes) {
      n.dispose();
    }
    _from.dispose();
    _to.dispose();
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  void _clearErr(int i) {
    if (_errs[i] == null) return;
    setState(() => _errs[i] = null);
  }

  static String _cleanPhone(String v) {
    var p = v.replaceAll(RegExp(r'[\s\-().]'), '');
    if (p.startsWith('+91')) {
      p = p.substring(3);
    } else if (p.length == 12 && p.startsWith('91')) {
      p = p.substring(2);
    } else if (p.length == 11 && p.startsWith('0')) {
      p = p.substring(1);
    }
    return p;
  }

  bool _validate() {
    final from = _from.text.trim();
    final to = _to.text.trim();
    final name = _name.text.trim();
    final phone = _cleanPhone(_phone.text);
    final errs = List<String?>.filled(4, null);
    if (from.length < 2) {
      errs[0] = 'From city is required.';
    }
    if (to.length < 2) {
      errs[1] = 'To city is required.';
    }
    if (name.length < 2) {
      errs[2] = 'Please enter your name.';
    }
    if (phone.isEmpty) {
      errs[3] = 'Phone number is required.';
    } else if (!_phoneRe.hasMatch(phone)) {
      errs[3] = 'Enter a valid 10-digit Indian mobile number (starts with 6-9).';
    }
    var bad = -1;
    setState(() {
      for (var i = 0; i < 4; i++) {
        _errs[i] = errs[i];
        if (errs[i] != null && bad < 0) bad = i;
      }
      if (bad >= 0) _active = bad;
    });
    if (bad >= 0) {
      _nodes[bad].requestFocus();
      return false;
    }
    return true;
  }

  String get _waText => 'ApnaShift callback request (Moving Soon?)\n'
      'From City: ${_from.text.trim()}\n'
      'To City: ${_to.text.trim()}\n'
      'Name: ${_name.text.trim()}\n'
      'Phone: ${_cleanPhone(_phone.text)}';

  Future<void> _openWhatsApp() async {
    final uri = Uri.parse(
        'https://wa.me/$_waNumber?text=${Uri.encodeComponent(_waText)}');
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('WhatsApp nahi khula — 918757160137 par likho.')));
    }
  }

  Future<void> _submit() async {
    if (!_validate()) return;
    setState(() => _submitted = true);
    unawaited(widget.store.write('submitted'));
    await _openWhatsApp();
  }

  InputDecoration _dec(int i, String hint) {
    final radius = BorderRadius.circular(10);
    return InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: _slate, fontSize: 17.5),
      filled: true,
      fillColor: Colors.white,
      errorText: _errs[i],
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      enabledBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(
            color: _active == i ? _orange : _line,
            width: _active == i ? 1.5 : 1.25),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: const BorderSide(color: _orange, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: const BorderSide(color: _red, width: 1.5),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: const BorderSide(color: _red, width: 1.5),
      ),
      errorStyle: const TextStyle(color: _red, fontSize: 13, height: 1.3),
      errorMaxLines: 2,
      counterText: '', // maxLength counter design me nahi chahiye
    );
  }

  TextField _field(int i, TextEditingController c, String hint,
      {TextInputType? kb, VoidCallback? onDone}) {
    return TextField(
      controller: c,
      focusNode: _nodes[i],
      keyboardType: kb,
      textInputAction: onDone == null ? TextInputAction.next : TextInputAction.done,
      maxLength: i == 3 ? 16 : 60,
      style: const TextStyle(color: _ink, fontSize: 17.5),
      cursorColor: _orange,
      onChanged: (_) => _clearErr(i),
      onSubmitted: (_) => onDone?.call(),
      decoration: _dec(i, hint),
    );
  }

  Widget _title() => const Text(
        'Moving Soon?',
        textAlign: TextAlign.center,
        style: TextStyle(
            color: _ink, fontSize: 32, fontWeight: FontWeight.w800, letterSpacing: -0.6),
      );

  Widget _sub() => const Text(
        'Let us help! Get a free, no-obligation callback from our '
        'ApnaShift App moving experts.',
        textAlign: TextAlign.center,
        style: TextStyle(color: _slate, fontSize: 17.5, height: 1.5),
      );

  Widget _form() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 30),
        _field(0, _from, 'From City'),
        const SizedBox(height: 14),
        _field(1, _to, 'To City'),
        const SizedBox(height: 14),
        _field(2, _name, 'Your Name'),
        const SizedBox(height: 14),
        _field(3, _phone, 'Phone Number*',
            kb: TextInputType.phone, onDone: _submit),
        const SizedBox(height: 20),
        SizedBox(
          height: 54,
          child: ElevatedButton(
            onPressed: _submit,
            style: ElevatedButton.styleFrom(
              backgroundColor: _orange,
              foregroundColor: Colors.white,
              elevation: 0,
              surfaceTintColor: Colors.transparent,
              padding: EdgeInsets.zero,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              textStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
            ),
            child: const Text('Get a Callback'),
          ),
        ),
      ],
    );
  }

  Widget _done() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 30),
        Container(
          width: 66,
          height: 66,
          alignment: Alignment.center,
          decoration: const BoxDecoration(color: _green, shape: BoxShape.circle),
          child: const Text('✓',
              style: TextStyle(
                  color: Colors.white, fontSize: 34, fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 18),
        const Text('Thank you!',
            textAlign: TextAlign.center,
            style: TextStyle(
                color: _ink, fontSize: 26, fontWeight: FontWeight.w800)),
        const SizedBox(height: 10),
        const Text(
          'Our ApnaShift moving expert will call you back shortly. '
          'Your details are ready on WhatsApp — press Send there to confirm.',
          textAlign: TextAlign.center,
          style: TextStyle(color: _slate, fontSize: 16.5, height: 1.5),
        ),
        const SizedBox(height: 18),
        SizedBox(
          height: 50,
          child: OutlinedButton(
            onPressed: _openWhatsApp,
            style: OutlinedButton.styleFrom(
              foregroundColor: _ink,
              side: const BorderSide(color: _line, width: 1.5),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              textStyle: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
            ),
            child: const Text('Open WhatsApp'),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    // Mobile par halka padding, bade screen par reference jaisa padding.
    final w = MediaQuery.sizeOf(context).width;
    final hPad = w < 420 ? 18.0 : 30.0;
    return Dialog(
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.transparent, // dark mode bhi white card (design)
      elevation: 24,
      clipBehavior: Clip.antiAlias,
      insetPadding: EdgeInsets.symmetric(horizontal: w < 420 ? 12 : 24, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 580),
        child: Stack(
          children: [
            // Content neeche, ✕ upar: scroll view upar raha to close button
            // ke tap ko scroll absorb kar lega (hit-test bug).
            SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(hPad, 36, hPad, 30),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _title(),
                  const SizedBox(height: 16),
                  if (!_submitted) ...[
                    _sub(),
                    _form(),
                  ] else
                    _done(),
                ],
              ),
            ),
            Positioned(
              top: 6,
              right: 6,
              child: IconButton(
                onPressed: () => Navigator.of(context).maybePop(),
                tooltip: 'Close',
                color: _slate,
                iconSize: 26,
                icon: const Icon(Icons.close),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
