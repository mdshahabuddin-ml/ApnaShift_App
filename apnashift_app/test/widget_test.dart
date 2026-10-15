// ApnaShift smoke test: boots to HOME (website index.html parity) with empty
// memory token store. No plugins, no network — ApiClient is never hit here.
import 'package:flutter_test/flutter_test.dart';

import 'package:apnashift_app/auth/session.dart';
import 'package:apnashift_app/auth/token_store.dart';
import 'package:apnashift_app/main.dart';
import 'package:apnashift_app/settings/app_settings.dart';

void main() {
  testWidgets('boots to home when logged out (Phase 1 parity)', (WidgetTester tester) async {
    final session = Session(store: MemoryTokenStore());
    final settings = AppSettings.test();
    await tester.pumpWidget(ApnaShiftApp(session: session, settings: settings));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('ApnaShift'), findsWidgets);
    // Home hero + vehicle grid (public landing, not login form).
    expect(find.textContaining('Move smarter'), findsOneWidget);
    expect(find.textContaining('Book now'), findsWidgets);
  });
}
