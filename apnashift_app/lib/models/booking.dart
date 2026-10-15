/// Booking (customer view) — mirrors backend toPublicBooking + attachPayments(user).
/// Defensive parse: missing keys -> null/defaults, never throws.
class Booking {
  final String id;
  final String status;
  final String vehicleType;
  final double? priceRs;
  final double? distanceKm;
  final String? pickupAddress;
  final double? pickupLat;
  final double? pickupLng;
  final String? dropAddress;
  final double? dropLat;
  final double? dropLng;
  final bool helperNeeded;
  final String? itemDescription;
  final DateTime? scheduledTime;
  final DateTime? deliveredAt;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String paymentMethod;
  final double? commissionPercent;
  final bool disputed;
  final String? disputeReason;
  final String? cancelReason;
  final String? cancelledBy;
  final DateTime? cancelledAt;
  final String? driverId;
  final BookingDriver? driver;
  final BookingPayment? payment;
  final Map<String, dynamic>? estimate;

  const Booking({
    required this.id,
    required this.status,
    required this.vehicleType,
    this.priceRs,
    this.distanceKm,
    this.pickupAddress,
    this.pickupLat,
    this.pickupLng,
    this.dropAddress,
    this.dropLat,
    this.dropLng,
    this.helperNeeded = false,
    this.itemDescription,
    this.scheduledTime,
    this.deliveredAt,
    this.createdAt,
    this.updatedAt,
    this.paymentMethod = 'upi',
    this.commissionPercent,
    this.disputed = false,
    this.disputeReason,
    this.cancelReason,
    this.cancelledBy,
    this.cancelledAt,
    this.driverId,
    this.driver,
    this.payment,
    this.estimate,
  });

  static double? _num(dynamic v) =>
      v == null ? null : double.tryParse(v.toString());
  static DateTime? _dt(dynamic v) =>
      v == null ? null : DateTime.tryParse(v.toString());

  static (String?, double?, double?) _point(Map<String, dynamic> j, String nested,
      String addrFlat, String latFlat, String lngFlat) {
    final n = j[nested];
    if (n is Map) {
      return (
        n['address']?.toString() ?? j[addrFlat]?.toString(),
        _num(n['lat'] ?? j[latFlat]),
        _num(n['lng'] ?? j[lngFlat]),
      );
    }
    return (
      j[addrFlat]?.toString(),
      _num(j[latFlat]),
      _num(j[lngFlat]),
    );
  }

  factory Booking.fromJson(Map<String, dynamic> j) {
    final pickup = _point(j, 'pickup', 'pickup_address', 'pickup_lat', 'pickup_lng');
    final drop = _point(j, 'drop', 'drop_address', 'drop_lat', 'drop_lng');
    final canc = j['cancellation'] is Map
        ? Map<String, dynamic>.from(j['cancellation'] as Map)
        : null;
    return Booking(
      id: (j['id'] ?? '').toString(),
      status: (j['status'] ?? 'pending').toString(),
      vehicleType: (j['vehicle_type'] ?? '').toString(),
      priceRs: _num(j['price_rs']),
      distanceKm: _num(j['distance_km']),
      pickupAddress: pickup.$1,
      pickupLat: pickup.$2,
      pickupLng: pickup.$3,
      dropAddress: drop.$1,
      dropLat: drop.$2,
      dropLng: drop.$3,
      helperNeeded: j['helper_needed'] == true || j['helper'] == true,
      itemDescription: j['item_description']?.toString(),
      scheduledTime: _dt(j['scheduled_time'] ?? j['scheduled_at']),
      deliveredAt: _dt(j['delivered_at']),
      createdAt: _dt(j['created_at']),
      updatedAt: _dt(j['updated_at']),
      paymentMethod: (j['payment_method'] ?? 'upi').toString(),
      commissionPercent: _num(j['commission_percent']),
      disputed: j['disputed'] == true,
      disputeReason: j['dispute_reason']?.toString(),
      cancelReason:
          canc?['reason']?.toString() ?? j['cancel_reason']?.toString(),
      cancelledBy:
          canc?['cancelled_by']?.toString() ?? j['cancelled_by']?.toString(),
      cancelledAt: _dt(canc?['cancelled_at'] ?? j['cancelled_at']),
      driverId: (j['driver_id'] ?? (j['driver'] is Map ? (j['driver'] as Map)['id'] : null))?.toString(),
      driver: j['driver'] is Map
          ? BookingDriver.fromJson(Map<String, dynamic>.from(j['driver'] as Map))
          : null,
      payment: j['payment'] is Map
          ? BookingPayment.fromJson(Map<String, dynamic>.from(j['payment'] as Map))
          : null,
      estimate: j['estimate'] is Map
          ? Map<String, dynamic>.from(j['estimate'] as Map)
          : null,
    );
  }

  bool get cancellable => status == 'pending' || status == 'accepted';
  bool get trackable =>
      driverId != null &&
      (status == 'accepted' || status == 'arrived' || status == 'in_transit');
  bool get rateable => status == 'delivered';
}

class BookingDriver {
  final String id;
  final String name;
  final String vehicleType;
  final String vehicleNumber;
  final String? upiId;

  const BookingDriver({
    required this.id,
    required this.name,
    required this.vehicleType,
    required this.vehicleNumber,
    this.upiId,
  });

  factory BookingDriver.fromJson(Map<String, dynamic> j) => BookingDriver(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        vehicleType: (j['vehicle_type'] ?? '').toString(),
        vehicleNumber: (j['vehicle_number'] ?? '').toString(),
        upiId: j['upi_id']?.toString(),
      );
}

/// Customer-visible payment (fare/method/status only — commission private).
class BookingPayment {
  final String method;
  final String status;
  final double? grossRs;

  const BookingPayment(
      {required this.method, required this.status, this.grossRs});

  factory BookingPayment.fromJson(Map<String, dynamic> j) => BookingPayment(
        method: (j['payment_method'] ?? j['method'] ?? 'upi').toString(),
        status: (j['payment_status'] ?? j['status'] ?? '').toString(),
        grossRs: j['gross_rs'] == null
            ? null
            : double.tryParse(j['gross_rs'].toString()),
      );
}

/// Server estimate: POST /api/bookings/estimate-price.
class PriceEstimate {
  final String vehicleType;
  final double distanceKm;
  final double baseFare;
  final double distanceFare;
  final double helperCharge;
  final double total;
  final double min;
  final double max;

  const PriceEstimate({
    required this.vehicleType,
    required this.distanceKm,
    required this.baseFare,
    required this.distanceFare,
    required this.helperCharge,
    required this.total,
    required this.min,
    required this.max,
  });

  static double _n(dynamic v) => double.tryParse('$v') ?? 0;

  factory PriceEstimate.fromJson(Map<String, dynamic> j) => PriceEstimate(
        vehicleType: (j['vehicle_type'] ?? '').toString(),
        distanceKm: _n(j['distance_km']),
        baseFare: _n(j['base_fare']),
        distanceFare: _n(j['distance_fare']),
        helperCharge: _n(j['helper_charge']),
        total: _n(j['total']),
        min: _n(j['estimate_min']),
        max: _n(j['estimate_max']),
      );
}

/// Website cancel reasons (booking.js CANCEL_REASONS parity).
const cancelReasons = [
  'wrong_pickup',
  'wrong_drop',
  'wrong_vehicle',
  'changed_plan',
  'duplicate',
  'driver_issue',
  'other',
];
