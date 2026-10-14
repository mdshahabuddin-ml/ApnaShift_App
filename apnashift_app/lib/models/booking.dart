/// Booking (customer view). Backend shape se defensive parse.
class Booking {
  final String id;
  final String status;
  final String vehicleType;
  final double? priceRs;
  final String? pickupAddress;
  final String? dropAddress;
  final DateTime? createdAt;

  const Booking({
    required this.id,
    required this.status,
    required this.vehicleType,
    this.priceRs,
    this.pickupAddress,
    this.dropAddress,
    this.createdAt,
  });

  static double? _num(dynamic v) => v == null ? null : double.tryParse(v.toString());
  static DateTime? _dt(dynamic v) => v == null ? null : DateTime.tryParse(v.toString());

  factory Booking.fromJson(Map<String, dynamic> j) => Booking(
        id: (j['id'] ?? '').toString(),
        status: (j['status'] ?? 'pending').toString(),
        vehicleType: (j['vehicle_type'] ?? '').toString(),
        priceRs: _num(j['price_rs']),
        pickupAddress: j['pickup_address']?.toString(),
        dropAddress: j['drop_address']?.toString(),
        createdAt: _dt(j['created_at']),
      );
}
