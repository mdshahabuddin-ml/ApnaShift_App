import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../api/api_client.dart';

/// Fetch-based SSE reader — website parity (notify.js / driver-dashboard /
/// tracking sab fetch + Bearer header use karte hain, EventSource nahi).
/// Backend har stream par 25s heartbeat (`: ping`) bhejta hai.
class SseEvent {
  final String event;
  final String data;
  const SseEvent(this.event, this.data);
}

/// Ek SSE text block (event/data lines) parse karo. Pure function — testable.
SseEvent? parseSseBlock(String block) {
  String? event;
  final data = <String>[];
  for (final line in block.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat/comment
    if (line.startsWith('event:')) {
      event = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      data.add(line.substring(5).trim());
    }
  }
  if (event == null && data.isEmpty) return null;
  return SseEvent(event ?? 'message', data.join('\n'));
}

/// GET stream kholo aur events yield karo. Caller cancel kare
/// (subscription.cancel + client stream close). Koi throw bahar nahi —
/// onEvent ke baad bhi connection toot sakta hai, caller reconnect kare.
Stream<SseEvent> openSse(ApiClient api, String path,
    {Map<String, String>? query}) async* {
  http.StreamedResponse res;
  try {
    res = await api.getStreamed(path, query: query);
  } catch (_) {
    return;
  }
  var buf = '';
  try {
    await for (final chunk
        in res.stream.transform(utf8.decoder)) {
      buf += chunk;
      while (true) {
        final idx = buf.indexOf('\n\n');
        if (idx < 0) break;
        final block = buf.substring(0, idx);
        buf = buf.substring(idx + 2);
        final ev = parseSseBlock(block);
        if (ev != null) yield ev;
      }
    }
  } catch (_) {
    // connection toot gaya — caller poll fallback par hai.
  }
}
