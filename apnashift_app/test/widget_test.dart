// ApnaShift smoke test: boots to login with empty memory token store.
// No plugins, no network — ApiClient is never hit on this path.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:apnashift_app/auth/session.dart';
import 'package:apnashift_app/auth/token_store.dart';
import 'package:apnashift_app/main.dart';

void main() {
  testWidgets('boots to login when logged out', (WidgetTester tester) async {
    final session = Session(store: MemoryTokenStore());
    await tester.pumpWidget(ApnaShiftApp(session: session));
    await tester.pumpAndSettle();
    expect(find.text('ApnaShift'), findsWidgets);
    expect(find.textContaining('Login'), findsWidgets);
    expect(find.byType(TextField), findsWidgets);
  });
}
