import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';

/// Shared admin UI helpers — error mapping + small widgets.
/// Backend codes mirror website toasts (admin-dashboard.html etc.).
String adminFriendly(Object e) {
  if (e is ApiException) {
    switch (e.code) {
      case 'invalid_credentials':
        return 'Galat number ya password.';
      case 'validation_failed':
        return 'Details check karo (filter/amount/ref).';
      case 'too_many_attempts':
        return 'Bahut requests — thoda ruk ke retry karo.';
      case 'maintenance_active':
        final m = e.message;
        return (m != null && m.isNotEmpty)
            ? 'Maintenance chal raha hai — $m'
            : 'Maintenance chal raha hai — actions thodi der me wapas chalu honge.';
      case 'not_found':
        return 'Nahi mila (galat id / doosri state).';
      case 'invalid_transition':
        return 'Ye action is state me allowed nahi.';
      case 'already_accepted':
        return 'Trip already accepted hai.';
      case 'driver_unavailable':
        return 'Driver available nahi (verify/active/vehicle dekho).';
      case 'vehicle_mismatch':
        return 'Driver ka vehicle trip se match nahi.';
      case 'settlement_exceeds_outstanding':
        return 'Amount outstanding se zyada hai.';
      case 'duplicate_settlement':
        return 'Duplicate settlement (reference dobara).';
      case 'settlement_finalized':
        return 'Week PAID/DISPUTED — frozen hai.';
      case 'idempotency_conflict':
        return 'Same key, alag data — nayi key banao.';
      default:
        return 'Fail (${e.code}). Retry karo.';
    }
  }
  return 'Server se baat nahi ho payi.';
}

Widget adminErrorCard(String msg) => Padding(
      padding: const EdgeInsets.all(24),
      child: Text(msg, style: const TextStyle(color: Colors.red)),
    );

Widget adminPill(String s) {
  Color c = Colors.grey;
  if (s == 'delivered' || s == 'PAID' || s == 'APPROVED' || s == 'CONVERTED') {
    c = Colors.green;
  }
  if (s == 'cancelled' || s == 'DISPUTED' || s == 'REJECTED' || s == 'CLOSED') {
    c = Colors.red;
  }
  if (s == 'accepted' ||
      s == 'arrived' ||
      s == 'in_transit' ||
      s == 'PARTIALLY_PAID' ||
      s == 'pending' ||
      s == 'PENDING_REVIEW' ||
      s == 'DUE' ||
      s == 'NEW' ||
      s == 'IN_DISCUSSION' ||
      s == 'CONTACTED') {
    c = Colors.blue;
  }
  if (s == 'OVERDUE') c = Colors.orange;
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
        color: c.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(20)),
    child: Text(s,
        style: TextStyle(
            color: c, fontWeight: FontWeight.w700, fontSize: 12)),
  );
}
