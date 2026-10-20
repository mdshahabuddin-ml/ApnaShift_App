import 'dart:async';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:screenshot/screenshot.dart';
import 'auth/admin_session.dart';
import 'auth/driver_session.dart';
import 'auth/session.dart';
import 'api/api_client.dart';
import 'screens/admin_home.dart';
import 'screens/admin_login_screen.dart';
import 'screens/customer_home.dart';
import 'screens/driver_home.dart';
import 'screens/driver_login_screen.dart';
import 'screens/driver_register_screen.dart';
import 'screens/enterprise_screen.dart';
import 'screens/help_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart' show navy, yellow, LoginScreen;
import 'settings/app_settings.dart';
import 'services/announcement_store.dart';
import 'services/update_check_service.dart';
import 'theme/app_theme.dart';
import 'util/error_reporter.dart';
import 'widgets/callback_popup.dart';

void main() {
  runZonedGuarded(() {
    ErrorReporter.init();
    // X-App-Version header + /latest?version= ke liye installed version.
    // Fail-soft: header missing = server allow karta hai (gate absent
    // header ko punish nahi karta).
    unawaited(PackageInfo.fromPlatform().then((info) {
      ApiClient.appVersion = info.version; // "1.0.0" (+build alag field)
    }).catchError((_) {
      ApiClient.appVersion = '';
    }));
    UpdateCheckService.instance.init();
    runApp(const ApnaShiftApp());
  }, (Object e, StackTrace s) => ErrorReporter.report('zone', '$e', s));
}

class ApnaShiftApp extends StatefulWidget {
  final Session? session;
  final AppSettings? settings;
  const ApnaShiftApp({super.key, this.session, this.settings});

  @override
  State<ApnaShiftApp> createState() => _ApnaShiftAppState();
}

class _ApnaShiftAppState extends State<ApnaShiftApp>
    with WidgetsBindingObserver {
  late final Session _session = widget.session ?? Session();
  late final AppSettings _settings = widget.settings ?? AppSettings();
  late final DriverSession _driver = DriverSession();
  late final AdminSession _admin = AdminSession();
  bool _updateDialogOpen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _session.addListener(_tick);
    _session.restore();
    _settings.addListener(_tick);
    _settings.load();
    _driver.addListener(_tick);
    _driver.restore();
    _admin.addListener(_tick);
    _admin.restore();
    // Announcement banner: per-id dismiss restore + pehla feed fetch.
    AnnouncementStore.instance.loadDismissed();
    AnnouncementStore.instance.startTicker();
    AnnouncementStore.instance.refresh();
    // App update: startup par ek check + pending aaye to dialog.
    UpdateCheckService.instance.addListener(_maybePromptUpdate);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(UpdateCheckService.instance.checkNow());
      _maybePromptUpdate();
      _maybeShowCallbackPopup();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Resume par halka version check (6h throttle service andar hai).
    if (state == AppLifecycleState.resumed) {
      unawaited(UpdateCheckService.instance.checkNow());
    }
  }

  void _maybePromptUpdate() {
    final svc = UpdateCheckService.instance;
    if (svc.pending == null || _updateDialogOpen || !mounted) return;
    _updateDialogOpen = true;
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AppUpdateDialog(service: svc),
    ).whenComplete(() {
      _updateDialogOpen = false;
      // Update dialog band hone par callback popup ko mauka do.
      _maybeShowCallbackPopup();
    });
  }

  /// First-visit "Moving Soon?" callback popup (callback_popup.dart):
  /// sirf guest (koi session nahi) aur ready-state par; gate apni taraf
  /// once-ever policy (secure storage) + re-entrancy guard dekhta hai.
  void _maybeShowCallbackPopup() {
    if (!mounted || _updateDialogOpen) return;
    if (!_session.ready || !_settings.ready) return;
    unawaited(CallbackPopupGate.instance.maybeShow(
      context,
      guest: !_session.loggedIn && !_driver.loggedIn && !_admin.loggedIn,
    ));
  }

  void _tick() {
    // Role change par banner feed ka audience sync (customer > driver).
    AnnouncementStore.instance.updateAudience(
      (_session.loggedIn && (_session.user?.isCustomer ?? false))
          ? 'user'
          : (_driver.loggedIn ? 'driver' : null),
    );
    setState(() {});
    // Settings/session ready hone par first-visit popup ka check yahin se
    // chalta hai (startup postFrame me aksar ready nahi hota).
    _maybeShowCallbackPopup();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _session.removeListener(_tick);
    _settings.removeListener(_tick);
    _driver.removeListener(_tick);
    _admin.removeListener(_tick);
    UpdateCheckService.instance.removeListener(_maybePromptUpdate);
    AnnouncementStore.instance.stopTicker();
    super.dispose();
  }

  ThemeMode _themeMode() {
    switch (_settings.themeMode) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  void _openLogin(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) => LoginScreen(
              session: _session,
              adminSession: _admin,
              settings: _settings)),
    );
  }

  void _openAdmin(BuildContext context) {
    if (_admin.loggedIn) {
      Navigator.of(context).push(
        MaterialPageRoute(
            builder: (_) =>
                AdminHome(session: _admin, settings: _settings)),
      );
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) => AdminLoginScreen(
              session: _admin, settings: _settings)),
    );
  }

  void _openDriverLogin(BuildContext context) {
    if (_driver.loggedIn) {
      Navigator.of(context).push(
        MaterialPageRoute(
            builder: (_) =>
                DriverHome(session: _driver, settings: _settings)),
      );
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) => DriverLoginScreen(
              session: _driver, settings: _settings)),
    );
  }

  void _openDriverJoin(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) => DriverRegisterScreen(
              session: _driver, settings: _settings)),
    );
  }

  void _todo(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final loggedIn = _session.loggedIn;
    final isCustomer = _session.user?.isCustomer ?? false;
    final delta = _settings.textDelta;
    return Screenshot(
      controller: ErrorReporter.shots,
      child: MaterialApp(
        title: 'ApnaShift',
        theme: buildLightTheme(delta),
        darkTheme: buildDarkTheme(delta),
        themeMode: _themeMode(),
        home: !_session.ready || !_settings.ready
            ? const Scaffold(body: Center(child: CircularProgressIndicator()))
            : !loggedIn
                ? Builder(
                    builder: (ctx) => HomeScreen(
                      session: _session,
                      settings: _settings,
                      onBook: () => _openLogin(ctx),
                      onLogin: () => _openLogin(ctx),
                      onDriverJoin: () => _openDriverJoin(ctx),
                      onDriverLogin: () => _openDriverLogin(ctx),
                      onEnterprise: () => Navigator.of(ctx).push(
                        MaterialPageRoute(
                            builder: (_) => EnterpriseScreen(
                                settings: _settings)),
                      ),
                      onHelp: () => Navigator.of(ctx).push(
                        MaterialPageRoute(
                            builder: (_) =>
                                HelpScreen(settings: _settings)),
                      ),
                      onAdmin: () => _openAdmin(ctx),
                    ),
                  )
                : isCustomer
                    ? CustomerHome(session: _session, settings: _settings)
                    : _WrongRoleScreen(session: _session),
      ),
    );
  }
}

/// Purana stored driver/admin token (fix se pehle ka) restore ho jaye to
/// 403 wali bookings screen ki jagah seedha logout ka rasta dikhao.
class _WrongRoleScreen extends StatelessWidget {
  final Session session;
  const _WrongRoleScreen({required this.session});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: navy,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Namaste, ${session.user?.name ?? ''}',
                    style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800)),
                const SizedBox(height: 12),
                const Text(
                  'Ye login driver/staff ka hai. Ye app sirf customer ke liye hai — customer number se login karo.',
                  style: TextStyle(color: Colors.white70),
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: () => session.logout(),
                  style: ElevatedButton.styleFrom(
                      backgroundColor: yellow, foregroundColor: navy, padding: const EdgeInsets.all(16)),
                  child: const Text('Logout karke customer se login karo →',
                      style: TextStyle(fontWeight: FontWeight.w800)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
