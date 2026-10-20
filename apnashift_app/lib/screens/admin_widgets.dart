import 'package:flutter/material.dart';
import '../api/api_client.dart';

/// Shared admin UI helpers — error mapping + small widgets.
/// Backend codes mirror website toasts (admin-dashboard.html etc.).
String adminFriendly(Object e) {
  if (e is ApiException) {
    switch (e.code) {
      case 'invalid_credentials':
        return 'Incorrect phone number or password.';
      case 'validation_failed':
        return 'Check the details (filter/amount/ref).';
      case 'too_many_attempts':
        return 'Too many requests — wait a moment and try again.';
      case 'maintenance_active':
        final m = e.message;
        return (m != null && m.isNotEmpty)
            ? 'Maintenance in progress — $m'
            : 'Maintenance in progress — actions will resume shortly.';
      case 'not_found':
        return 'Not found (invalid id / different state).';
      case 'invalid_transition':
        return 'This action is not allowed in this state.';
      case 'already_accepted':
        return 'The trip has already been accepted.';
      case 'driver_unavailable':
        return 'Driver is not available (check verify/active/vehicle).';
      case 'vehicle_mismatch':
        return "The driver's vehicle does not match the trip.";
      case 'settlement_exceeds_outstanding':
        return 'Amount exceeds the outstanding balance.';
      case 'duplicate_settlement':
        return 'Duplicate settlement (reference already used).';
      case 'settlement_finalized':
        return 'This week is PAID/DISPUTED — it is frozen.';
      case 'idempotency_conflict':
        return 'Same key, different data — create a new key.';
      default:
        return 'Failed (${e.code}). Try again.';
    }
  }
  return 'Unable to connect to the server.';
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
