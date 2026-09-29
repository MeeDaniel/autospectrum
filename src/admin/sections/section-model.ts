import { assessBooking, type AdminBooking, type AdminSnapshot, type BookingStatus } from '../../domain/admin';

export type BookingFilters = {
  query: string;
  date: string;
  status: BookingStatus | '';
  categoryId: string;
  serviceId: string;
  conflictsOnly: boolean;
};

export function filterBookings(snapshot: AdminSnapshot, filters: BookingFilters): AdminBooking[] {
  const query = filters.query.trim().toLocaleLowerCase('ru');
  return snapshot.bookings.filter(booking => {
    const service = snapshot.services.find(item => item.id === booking.serviceId);
    return (!filters.date || booking.date === filters.date)
      && (!filters.status || booking.status === filters.status)
      && (!filters.serviceId || booking.serviceId === filters.serviceId)
      && (!filters.categoryId || service?.categoryId === filters.categoryId)
      && (!filters.conflictsOnly || assessBooking(booking, snapshot).length > 0)
      && (!query || [booking.name, booking.phone, booking.car].some(value => value.toLocaleLowerCase('ru').includes(query)));
  }).sort((a, b) => b.date.localeCompare(a.date) || a.startMinute - b.startMinute);
}

export function impactedBookings(current: AdminSnapshot, proposed: AdminSnapshot): AdminBooking[] {
  const key = (item: ReturnType<typeof assessBooking>[number]) => `${item.kind}:${item.start}:${item.end}:${item.bookingIds.join(',')}`;
  return proposed.bookings.filter(booking => {
    const old = new Set(assessBooking(booking, current).map(key));
    return assessBooking(booking, proposed).some(conflict => !old.has(key(conflict)));
  });
}
