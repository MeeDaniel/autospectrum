export type StaffRole = 'staff' | 'operator';
export type StaffAccount = { id: string; login: string; role: StaffRole; blocked: boolean };
