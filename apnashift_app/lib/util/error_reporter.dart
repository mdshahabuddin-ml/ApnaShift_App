import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:screenshot/screenshot.dart';

/// Auto error reports: framework/platform/zone crashes -> timestamped
/// screenshot + log in app-private `error-screenshots/` (no permission
/// needed, gallery me nahi jata). Tokens redact hote hain. Max 40 files.
class ErrorReporter {
  static final ScreenshotController shots = ScreenshotController();
  static bool _ready = false;

  static void init() {
    if (_ready) return;
    _ready = true;
    FlutterError.onError = (details) {
      report('flutter', details.exceptionAsString(), details.stack);
    };
    PlatformDispatcher.instance.onError = (Object e, StackTrace s) {
      report('platform', '$e', s);
      return true;
    };
  }

  static String _redact(String s) =>
      s.replaceAll(RegExp(r'Bearer [^\s]+'), 'Bearer [redacted]');

  static String _stamp() =>
      DateTime.now().toIso8601String().replaceAll(':', '-').split('.').first;

  static Future<void> report(String kind, String error, StackTrace? stack) async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final dir = Directory('${docs.path}/error-screenshots');
      await dir.create(recursive: true);
      final ts = _stamp();
      try {
        final img = await shots
            .capture()
            .timeout(const Duration(seconds: 3));
        if (img != null) {
          await File('${dir.path}/$ts-$kind.png').writeAsBytes(img);
        }
      } catch (_) {
        // Screenshot na ho paye to log to banta hi hai.
      }
      await File('${dir.path}/$ts-$kind.log').writeAsString(
        'kind=$kind\ntime=${DateTime.now().toIso8601String()}\nerror=${_redact(error)}\nstack=${_redact('$stack')}',
      );
      final files =
          await dir.list().where((e) => e is File).cast<File>().toList();
      files.sort((a, b) => a.path.compareTo(b.path));
      while (files.length > 40) {
        await files.removeAt(0).delete();
      }
      debugPrint('error-report saved: $ts-$kind');
    } catch (_) {
      // Reporter khud kabhi crash nahi karega.
    }
  }
}
